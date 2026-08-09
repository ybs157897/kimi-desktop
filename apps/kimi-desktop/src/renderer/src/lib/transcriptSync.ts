/**
 * TranscriptSync — the standard zero-gap rebuild flow for one (session, agent),
 * as specified in the desktop-app design doc and validated by kimi-inspect:
 *
 *  1. REST baseline: `GET .../transcript` (newest page, replace) — the only
 *     source of FULL state.
 *  2. WS `subscribe_v2` with grade `delta` and the `transcript_since` cursor
 *     (our op-batch watermark), applied as `transcript.ops` increments onto
 *     the same store — `append` chunks included, so thinking / assistant
 *     text streams live.
 *  3. Seq gaps (a batch with `seq > watermark + 1`), `resync_required`, the
 *     post-reconnect subscribe ack, and append-placement gaps trigger a
 *     point-to-point catch-up (`GET .../transcript/ops?since_seq=`); a
 *     `complete: false` answer (journal no longer reaches our watermark) or a
 *     legacy server (no seqs) falls back to a full REST refresh, which
 *     re-covers the previously loaded window via `before_turn` paging.
 *  4. History is paged separately with `before_turn` (`loadOlder`), one turn
 *     at a time.
 *
 * All refresh-style triggers run through a coalesced runner (at most one in
 * flight, trailing triggers coalesce into one follow-up run). Ops that arrive
 * while a refresh/catch-up is in flight are buffered and flushed onto the
 * fresh state — idempotent upserts and offset-placed appends converge.
 */

import type { AgentTranscriptSnapshot, TranscriptOperation } from '@moonshot-ai/transcript';

import { TRANSCRIPT_PAGE_SIZE, type ApiClient, type TranscriptPage } from './api';
import {
  createCoalescedRunner,
  oldestTurnId,
  recoverLoadedWindow,
  TranscriptChatStore,
} from './transcript/chatStore';
import { createTranscriptSocket, type TranscriptFrameMeta, TranscriptSocket } from './ws';

export interface TranscriptSyncOptions {
  readonly api: ApiClient;
  readonly sessionId: string;
  readonly agentId: string;
  readonly store: TranscriptChatStore;
  /** REST page size for the initial load / refresh / older paging. Default 1 (turn). */
  readonly pageSize?: number;
  /** WebSocket implementation override (tests). Defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: typeof WebSocket;
  /** Load state changes: `{ loaded, error }` after every (re)load attempt. */
  readonly onLoadState?: ((state: { loaded: boolean; error: unknown }) => void);
}

export class TranscriptSync {
  readonly #api: ApiClient;
  readonly #sessionId: string;
  readonly #agentId: string;
  readonly #store: TranscriptChatStore;
  readonly #pageSize: number;
  readonly #onLoadState?: ((state: { loaded: boolean; error: unknown }) => void);

  #ws: TranscriptSocket | undefined;
  #WebSocketImpl: typeof WebSocket | undefined;
  #stopped = false;

  // While a REST reload / catch-up is in flight, WS ops are buffered, then flushed.
  #fetching = true;
  #buffer: Array<{ ops: readonly TranscriptOperation[]; seq: number | undefined }> = [];
  /**
   * Op-batch watermark: the store is known to include every batch with
   * seq <= #lastSeq. Sourced from REST page watermarks and applied batch seqs;
   * `undefined` until a sequenced server provides one (legacy servers never
   * do — every recovery then falls back to full refreshes).
   */
  #lastSeq: number | undefined;
  /** True once the initial page load succeeded (gates reset-driven catch-up). */
  #seeded = false;

  #loaded = false;
  #loadError: unknown = null;

  constructor(options: TranscriptSyncOptions) {
    this.#api = options.api;
    this.#sessionId = options.sessionId;
    this.#agentId = options.agentId;
    this.#store = options.store;
    this.#pageSize = options.pageSize ?? TRANSCRIPT_PAGE_SIZE;
    this.#onLoadState = options.onLoadState;
    this.#WebSocketImpl = options.WebSocketImpl;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get loadError(): unknown {
    return this.#loadError;
  }

  /** Full-state (re)load body shared by the initial load, the full refresh and
   *  the catch-up fallback. */
  readonly #reloadPages = async (): Promise<void> => {
    // The window's oldest turn is the re-cover anchor: after a refresh the
    // server window may have shifted, and only re-loading up to THIS turn
    // preserves the previously loaded history.
    const prevOldest = oldestTurnId(this.#store.getState().items);
    const newest = await this.#api.transcriptPage(this.#sessionId, this.#agentId, {
      pageSize: this.#pageSize,
    });
    if (this.#stopped) return;
    this.#store.applyPage(newest, { replace: true });
    this.#lastSeq = newest.seq;
    // Re-cover the previously loaded window for refreshes (a no-op on the
    // initial load, where there is no previous oldest turn).
    await recoverLoadedWindow(
      this.#store,
      prevOldest,
      (beforeTurn) =>
        this.#api.transcriptPage(this.#sessionId, this.#agentId, {
          beforeTurn,
          pageSize: this.#pageSize,
        }),
      () => this.#stopped,
    );
    if (!this.#stopped) {
      this.#seeded = true;
      this.#loaded = true;
      this.#loadError = null;
      this.#onLoadState?.({ loaded: true, error: null });
    }
  };

  /** Full-state (re)load: the legacy recovery path and the initial load. */
  readonly #refresh = createCoalescedRunner(async (): Promise<void> => {
    this.#fetching = true;
    this.#buffer = [];
    try {
      await this.#reloadPages();
    } catch (error) {
      if (!this.#stopped) {
        this.#loadError = error;
        this.#onLoadState?.({ loaded: this.#loaded, error });
      }
    } finally {
      this.#flushBuffer();
    }
  });

  /**
   * Targeted catch-up: fetch exactly the op batches after our watermark
   * (`GET .../transcript/ops?since_seq=`). Falls back to a full page reload on
   * a legacy server (no seq / endpoint missing), a journal that no longer
   * covers the gap (`complete: false`), or a fetch failure.
   */
  readonly #catchUp = createCoalescedRunner(async (): Promise<void> => {
    if (this.#lastSeq === undefined) {
      this.#refresh();
      return;
    }
    this.#fetching = true;
    this.#buffer = [];
    try {
      const res = await this.#api.transcriptOps(this.#sessionId, this.#agentId, this.#lastSeq);
      if (this.#stopped) return;
      if (!res.complete) {
        await this.#reloadPages();
      } else {
        for (const batch of res.batches) this.#store.applyOps(batch.ops);
        this.#noteSeq(res.latestSeq);
      }
    } catch {
      try {
        await this.#reloadPages();
      } catch (error) {
        if (!this.#stopped) {
          this.#loadError = error;
          this.#onLoadState?.({ loaded: this.#loaded, error });
        }
      }
    } finally {
      this.#flushBuffer();
    }
  });

  #noteSeq(seq: number | undefined): void {
    if (seq === undefined) return;
    this.#lastSeq = this.#lastSeq === undefined ? seq : Math.max(this.#lastSeq, seq);
  }

  #flushBuffer(): void {
    this.#fetching = false;
    const buffered = this.#buffer;
    this.#buffer = [];
    for (const batch of buffered) {
      if (batch.seq !== undefined && this.#lastSeq !== undefined) {
        if (batch.seq <= this.#lastSeq) continue;
        if (batch.seq > this.#lastSeq + 1) {
          this.#catchUp();
          return;
        }
      }
      this.#store.applyOps(batch.ops);
      this.#noteSeq(batch.seq);
    }
  }

  /** Begin the sync: REST baseline load + WS subscription. Idempotent. */
  start(): void {
    if (this.#ws !== undefined) return;
    this.#stopped = false;
    const handlers = {
      onOps: (agentId: string, ops: readonly TranscriptOperation[], meta?: TranscriptFrameMeta) => {
        if (agentId !== this.#agentId) return;
        if (this.#fetching) {
          this.#buffer.push({ ops, seq: meta?.seq });
          return;
        }
        // Seq gap: the store is behind by at least one batch. Catch up
        // point-to-point instead of applying on a stale base (appends are
        // offset-placed and would surface a gap anyway).
        if (meta?.seq !== undefined && this.#lastSeq !== undefined && meta.seq > this.#lastSeq + 1) {
          this.#catchUp();
          return;
        }
        this.#store.applyOps(ops);
        this.#noteSeq(meta?.seq);
      },
      onReset: (
        _agentId: string,
        _snapshot: AgentTranscriptSnapshot,
        _hasMoreOlder: boolean,
        _meta?: TranscriptFrameMeta,
      ) => {
        // Baseline snapshots are deliberately ignored (full state is
        // REST-sourced). Sequenced mode only: a reset after seeding means the
        // server could not replay from our `transcript_since` cursor (journal
        // truncated) — catch up, which itself falls back to a full reload
        // when the seq window is gone. On legacy servers (no watermark)
        // resets are routine per-subscribe noise and stay ignored.
        if (this.#seeded && this.#lastSeq !== undefined) this.#catchUp();
      },
      onResyncRequired: () => {
        this.#catchUp();
      },
      onReconnected: () => {
        // The server attaches the transcript stream only after processing
        // subscribe_v2; ops emitted between the REST page load and that point
        // are missed — reconcile.
        this.#catchUp();
      },
    };
    this.#ws = createTranscriptSocket({
      url: this.#api.baseUrl,
      token: this.#api.token,
      sessionId: this.#sessionId,
      agentId: this.#agentId,
      getSince: () => this.#lastSeq,
      handlers,
      WebSocketImpl: this.#WebSocketImpl,
    });
    this.#store.onGap = () => this.#catchUp();
    this.#refresh();
  }

  /** Tear the current subscription down. A later `start` resumes this sync. */
  stop(): void {
    this.#stopped = true;
    this.#ws?.close();
    this.#ws = undefined;
    this.#store.onGap = undefined;
  }

  /**
   * Page older history with a `before_turn` cursor (one page at a time).
   * Resolves when the page was applied (or immediately when nothing older
   * exists). Errors propagate to the caller.
   */
  async loadOlder(): Promise<void> {
    const oldest = oldestTurnId(this.#store.getState().items);
    if (oldest === undefined || !this.#store.getState().hasMoreOlder) return;
    const page = await this.#api.transcriptPage(this.#sessionId, this.#agentId, {
      beforeTurn: oldest,
      pageSize: this.#pageSize,
    });
    if (!this.#stopped) this.#store.applyPage(page);
  }

  /** Fetch a specific page backwards (jump navigation); used by the timeline. */
  fetchPageBefore(beforeTurn: string): Promise<TranscriptPage> {
    return this.#api.transcriptPage(this.#sessionId, this.#agentId, {
      beforeTurn,
      pageSize: this.#pageSize,
    });
  }

  /**
   * Force a full REST baseline refresh (newest page replace + window
   * recovery). Coalesced like every other refresh trigger; ops arriving
   * meanwhile are buffered and flushed onto the fresh state. Used after
   * destructive session actions (undo) that rewrite history server-side.
   */
  refresh(): void {
    this.#refresh();
  }
}
