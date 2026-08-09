/**
 * `/api/v1/ws` clients for the desktop renderer — two independent sockets,
 * the pattern kimi-inspect validated:
 *
 *  - **activity socket** (`createActivitySocket`): sends `client_hello` with
 *    an empty subscription list and consumes only the server-pushed global
 *    facts (`event.session.work_changed`, `event.session.created`,
 *    `session.meta.updated`, `event.config.changed`) that drive the sidebar
 *    badges and query invalidation. Global frames are live-only — a drop loses
 *    whatever fired meanwhile, so the consumer answers `onReconnected` with a
 *    REST re-seed. Optionally follows one session's mode-state events
 *    (`follow(sessionId)`): a `subscribe_v2` at transcript grade `'off'`,
 *    which is the one grade that does NOT suppress `agent.status.updated` /
 *    `goal.updated` (the transcript socket at `block` never sees them).
 *  - **transcript socket** (`createTranscriptSocket`): the incremental channel
 *    for one (session, agent) at `delta` grade — the full stream including
 *    per-token `append` chunks, so thinking / assistant text renders live
 *    (whole-state frame upserts still land at flush points). After
 *    `client_hello` it sends `subscribe_v2` carrying the grade map plus the
 *    `transcript_since` cursor (when a watermark is known) and forwards every
 *    `transcript.ops` frame to the consumer. Loss signals (`resync_required`,
 *    the subscribe_v2 ack after every reconnect) are surfaced, not repaired
 *    locally — transcript frames are volatile by design (never journaled), so
 *    the consumer answers with a REST catch-up/refresh.
 *
 * Both sockets authenticate at the upgrade via the `kimi-code.bearer.<token>`
 * subprotocol (the only credential channel a browser WebSocket has), reconnect
 * with exponential backoff (500 ms doubling, capped at 10 s), and answer
 * server `ping` frames with `pong`.
 */

import {
  agentStatusUpdatedEventSchema,
  goalUpdatedEventSchema,
  type AgentStatusUpdatedEvent,
  type GoalSnapshot,
} from '@moonshot-ai/protocol';
import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
const CLIENT_ID = 'kimi-desktop';
/** Base delay for the reconnect backoff; doubles per attempt, capped at 10 s. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 10_000;

type WebSocketCtor = typeof WebSocket;

export interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly seq?: number;
  readonly session_id?: string;
  readonly terminal_id?: string;
  readonly timestamp?: string;
  readonly payload?: unknown;
}

/** Derive the `/api/v1/ws` WebSocket URL from a server base URL. */
function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v1/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

abstract class BaseSocket {
  protected readonly wsUrl: string;
  protected readonly token?: string;
  protected readonly WebSocketCtor: WebSocketCtor;
  protected readonly reconnectDelayMs: number;

  protected ws: WebSocket | undefined;
  protected manualClose = false;
  protected reconnectAttempt = 0;
  protected reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly url: string;
    readonly token?: string;
    readonly WebSocketImpl?: WebSocketCtor;
    readonly reconnectDelayMs?: number;
  }) {
    this.wsUrl = toWsUrl(options.url);
    this.token = options.token;
    const ctor = options.WebSocketImpl ?? globalThis.WebSocket;
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WebSocketCtor = ctor;
    this.reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.connect();
  }

  /** Tear the socket down permanently. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  protected connect(): void {
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WebSocket;
    try {
      ws = new this.WebSocketCtor(this.wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.onOpen();
    });
    ws.addEventListener('message', (event: MessageEvent) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      // Stale socket (a manual close already cleared `this.ws`).
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  protected abstract onOpen(): void;

  protected onMessage(raw: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === 'ping') {
      const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
      this.send({ type: 'pong', payload: { nonce } });
      return;
    }
    this.onFrame(frame);
  }

  /** Handle a non-ping server frame. */
  protected abstract onFrame(frame: ServerFrame): void;

  protected scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  protected send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }
}

// ---------------------------------------------------------------- activity

export type SessionPendingInteraction = 'none' | 'approval' | 'question';
export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

/** Coarse per-session work facts pushed by `event.session.work_changed`. */
export interface SessionWorkFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: SessionTurnOutcome;
}

export interface ActivitySocketHandlers {
  /** Coarse work-fact tuple for one session changed. */
  onWorkChanged: (sessionId: string, facts: SessionWorkFacts) => void;
  /** A session was created (list-level signal). */
  onSessionCreated: (sessionId: string) => void;
  /** A session's title/patch changed (list-level signal). */
  onMetaUpdated: (sessionId: string) => void;
  /** Server-side config changed (providers / default model / permission mode …). */
  onConfigChanged: () => void;
  /** The followed session's agent status changed (model / permission / plan /
   *  swarm mode). Optional — set when the caller follows a session. */
  onStatusUpdated?: (sessionId: string, event: AgentStatusUpdatedEvent) => void;
  /** The followed session's goal snapshot changed (null = goal cleared). */
  onGoalUpdated?: (sessionId: string, snapshot: GoalSnapshot | null) => void;
  /** Catch-all for frames not handled by the handlers above (e.g. `subagent.*`
   *  lifecycle events that this socket otherwise drops). The raw frame is
   *  forwarded untouched; parsing is the caller's responsibility. */
  onRawFrame?: (frame: ServerFrame) => void;
  /** Socket established (initial connect and every reconnect) — live facts are
   *  missed while down, the consumer answers with a REST re-seed. */
  onReconnected: () => void;
}

export interface ActivitySocketOptions {
  /** Server base URL (`http(s)://host:port`). */
  readonly url: string;
  readonly token?: string;
  readonly handlers: ActivitySocketHandlers;
  /** Session whose mode-state events (`agent.status.updated`, `goal.updated`)
   *  to follow from the first connect; `null` (default) follows nothing. The
   *  subscription is on `subscribe_v2` with transcript grade `'off'` — the
   *  events are suppressed for transcript-grade subscribers, so this socket
   *  must never hold a transcript grade. */
  readonly followSessionId?: string | null;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WebSocketCtor;
}

/** Factory for the global-facts socket (no session subscriptions). */
export function createActivitySocket(options: ActivitySocketOptions): ActivitySocket {
  return new ActivitySocket(options);
}

export class ActivitySocket extends BaseSocket {
  readonly #handlers: ActivitySocketHandlers;
  #followSessionId: string | null;
  #requestSeq = 0;

  constructor(options: ActivitySocketOptions) {
    super(options);
    this.#handlers = options.handlers;
    this.#followSessionId = options.followSessionId ?? null;
  }

  #nextId(action: string): string {
    this.#requestSeq += 1;
    return `${CLIENT_ID}-global-${action}-${this.#requestSeq}`;
  }

  #sendSubscribeV2(sessionId: string): void {
    this.send({
      type: 'subscribe_v2',
      id: this.#nextId('sub'),
      payload: {
        session_id: sessionId,
        transcript: { main: 'off' },
      },
    });
  }

  /**
   * Follow a session's mode-state events (`agent.status.updated`,
   * `goal.updated`), replacing the previous follow. Session events only reach
   * connections attached to that session; grade `'off'` keeps the frames
   * unsuppressed. Call with `null` to stop following.
   */
  follow(sessionId: string | null): void {
    if (sessionId === this.#followSessionId) return;
    const previous = this.#followSessionId;
    this.#followSessionId = sessionId;
    if (this.ws === undefined || this.ws.readyState !== WebSocket.OPEN) return;
    // While the socket is closed the next connect re-subscribes on its own.
    if (previous !== null) {
      this.send({
        type: 'unsubscribe_v2',
        id: this.#nextId('unsub'),
        payload: { session_id: previous },
      });
    }
    if (sessionId !== null) this.#sendSubscribeV2(sessionId);
  }

  protected onOpen(): void {
    this.send({
      type: 'client_hello',
      id: `${CLIENT_ID}-global-${Date.now().toString(36)}`,
      payload: { client_id: CLIENT_ID, subscriptions: [] },
    });
    if (this.#followSessionId !== null) this.#sendSubscribeV2(this.#followSessionId);
    // Established (first connect and every reconnect alike): live facts may
    // have been missed — the consumer re-seeds from REST.
    this.#handlers.onReconnected();
  }

  protected onFrame(frame: ServerFrame): void {
    const sessionId = frame.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    switch (frame.type) {
      case 'event.session.work_changed': {
        const facts = parseWorkFacts(frame.payload);
        if (facts !== undefined) this.#handlers.onWorkChanged(sessionId, facts);
        return;
      }
      case 'event.session.created': {
        this.#handlers.onSessionCreated(sessionId);
        return;
      }
      case 'session.meta.updated': {
        this.#handlers.onMetaUpdated(sessionId);
        return;
      }
      case 'event.config.changed': {
        this.#handlers.onConfigChanged();
        return;
      }
      case 'agent.status.updated': {
        if (this.#handlers.onStatusUpdated === undefined) return;
        const parsed = agentStatusUpdatedEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.#handlers.onStatusUpdated(sessionId, parsed.data);
        return;
      }
      case 'goal.updated': {
        if (this.#handlers.onGoalUpdated === undefined) return;
        const parsed = goalUpdatedEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.#handlers.onGoalUpdated(sessionId, parsed.data.snapshot);
        return;
      }
      default:
        this.#handlers.onRawFrame?.(frame);
        return;
    }
  }
}

function parseWorkFacts(payload: unknown): SessionWorkFacts | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p['busy'] !== 'boolean') return undefined;
  const pending = p['pending_interaction'];
  const reason = p['last_turn_reason'];
  return {
    busy: p['busy'],
    mainTurnActive: p['main_turn_active'] === true,
    pendingInteraction: pending === 'approval' || pending === 'question' ? pending : 'none',
    lastTurnReason:
      reason === 'completed' || reason === 'cancelled' || reason === 'failed' ? reason : undefined,
  };
}

// --------------------------------------------------------------- transcript

/** Envelope/payload metadata carried alongside a transcript frame. */
export interface TranscriptFrameMeta {
  /** Envelope `timestamp` (server send time, ISO); absent on legacy servers. */
  readonly at?: string;
  /** Op-batch sequence number (payload `seq`); absent on legacy servers. */
  readonly seq?: number;
}

export interface TranscriptSocketHandlers {
  /** Incremental L2 op batch for the agent (the only data frame consumed). */
  onOps: (agentId: string, ops: readonly TranscriptOperation[], meta?: TranscriptFrameMeta) => void;
  /** Baseline snapshot frame — surfaced for observers; the chat store ignores
   *  it (full state is REST-sourced). */
  onReset?: (
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    hasMoreOlder: boolean,
    meta?: TranscriptFrameMeta,
  ) => void;
  /** Server signalled desync for our session — consumer should REST-refresh. */
  onResyncRequired: (sessionId: string) => void;
  /** Socket re-established after a drop — volatile ops were missed meanwhile.
   *  Fires on the `subscribe_v2` ACK (the server attaches the transcript
   *  stream only after processing it). */
  onReconnected: () => void;
}

export interface TranscriptSocketOptions {
  /** Server base URL (`http(s)://host:port`). */
  readonly url: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly handlers: TranscriptSocketHandlers;
  /** Returns the caller's current op-batch watermark at (re)subscribe time;
   *  when defined it is sent as the `transcript_since` cursor so a sequenced
   *  server replays missed batches instead of sending a baseline reset. */
  readonly getSince?: (() => number | undefined);
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WebSocketCtor;
}

/** Factory for the transcript-delta socket of one (session, agent). */
export function createTranscriptSocket(options: TranscriptSocketOptions): TranscriptSocket {
  return new TranscriptSocket(options);
}

export class TranscriptSocket extends BaseSocket {
  readonly #sessionId: string;
  readonly #agentId: string;
  readonly #handlers: TranscriptSocketHandlers;
  readonly #getSince?: (() => number | undefined);

  #subscribeV2Id: string | undefined;
  #subscribeV2Acked = false;

  constructor(options: TranscriptSocketOptions) {
    super(options);
    this.#sessionId = options.sessionId;
    this.#agentId = options.agentId;
    this.#handlers = options.handlers;
    this.#getSince = options.getSince;
  }

  protected onOpen(): void {
    const helloId = `${CLIENT_ID}-${Date.now().toString(36)}`;
    this.#subscribeV2Id = `${helloId}-sub`;
    this.#subscribeV2Acked = false;
    this.send({
      type: 'client_hello',
      id: helloId,
      payload: {
        client_id: CLIENT_ID,
        subscriptions: [this.#sessionId],
      },
    });
    // Transcript grades ride only `subscribe_v2` — sent right after the hello
    // on the same socket, so the server processes them in order.
    const since = this.#getSince?.();
    this.send({
      type: 'subscribe_v2',
      id: this.#subscribeV2Id,
      payload: {
        session_id: this.#sessionId,
        transcript: { [this.#agentId]: 'delta' },
        transcript_since: since !== undefined ? { [this.#agentId]: since } : undefined,
      },
    });
    // The reconcile fires on the subscribe_v2 ACK (see onFrame) — refreshing
    // at open could finish before the subscription is active and still miss
    // the ops in between.
  }

  protected onFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ack': {
        // The subscribe_v2 ack: the server has attached the transcript stream
        // by now — reconcile once per socket (ops emitted between the REST
        // page load and this point are missed; the consumer refreshes).
        if (!this.#subscribeV2Acked && frame.id !== undefined && frame.id === this.#subscribeV2Id) {
          this.#subscribeV2Acked = true;
          this.#handlers.onReconnected();
        }
        return;
      }
      case 'transcript.ops': {
        const parsed = transcriptOpsEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.#handlers.onOps(parsed.data.agent_id, parsed.data.ops, {
          at: frame.timestamp,
          seq: parsed.data.seq,
        });
        return;
      }
      case 'transcript.reset': {
        if (this.#handlers.onReset === undefined) return;
        const parsed = transcriptResetEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.#handlers.onReset(
          parsed.data.agent_id,
          parsed.data.snapshot,
          parsed.data.has_more_older,
          { at: frame.timestamp, seq: parsed.data.seq },
        );
        return;
      }
      case 'resync_required': {
        const sessionId = (frame.payload as { session_id?: unknown } | undefined)?.session_id;
        if (sessionId === this.#sessionId) this.#handlers.onResyncRequired(this.#sessionId);
        return;
      }
      default:
        // server_hello / legacy session events — not consumed here.
        return;
    }
  }
}

// ------------------------------------------------------------------ terminal
// The PTY I/O channel. REST manages lifecycle (create/list/close); this socket
// attaches to one terminal, forwards input + resize, and receives the
// sequenced `terminal_output` / `terminal_exit` stream. `since_seq` on attach
// replays output that arrived while the socket was down.

export interface TerminalSocketHandlers {
  /** Output bytes arrived (UTF-8 string). `seq` is the event sequence number. */
  onOutput: (data: string, seq: number) => void;
  /** The PTY exited (optional exit code). */
  onExit: (exitCode: number | null | undefined) => void;
  /** Attach ACK: the server replayed `replayed` events from `since_seq`. */
  onAttached: (replayed: number) => void;
  /** Socket re-established after a drop; the owner re-attaches (replay gap). */
  onReconnected: () => void;
}

export interface TerminalSocketOptions {
  /** Server base URL (`http(s)://host:port`). */
  readonly url: string;
  readonly token?: string;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly handlers: TerminalSocketHandlers;
  /** The caller's current output seq watermark at (re)attach; the server
   *  replays events after it. Undefined on first attach. */
  readonly getSince?: (() => number | undefined);
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WebSocketCtor;
}

/** Factory for the PTY I/O socket of one (session, terminal). */
export function createTerminalSocket(options: TerminalSocketOptions): TerminalSocket {
  return new TerminalSocket(options);
}

export class TerminalSocket extends BaseSocket {
  readonly #sessionId: string;
  readonly #terminalId: string;
  readonly #handlers: TerminalSocketHandlers;
  readonly #getSince?: (() => number | undefined);

  #attached = false;
  #requestSeq = 0;

  #nextId(action: string): string {
    this.#requestSeq += 1;
    return `${CLIENT_ID}-term-${action}-${this.#requestSeq}`;
  }

  constructor(options: TerminalSocketOptions) {
    super(options);
    this.#sessionId = options.sessionId;
    this.#terminalId = options.terminalId;
    this.#handlers = options.handlers;
    this.#getSince = options.getSince;
  }

  protected onOpen(): void {
    this.#attached = false;
    this.send({
      type: 'client_hello',
      id: `${CLIENT_ID}-term-${Date.now().toString(36)}`,
      payload: { client_id: CLIENT_ID, subscriptions: [this.#sessionId] },
    });
    // Attach right after the hello. `since_seq` replays output missed while the
    // socket was down; undefined on the first attach means "from the start".
    const since = this.#getSince?.();
    this.send({
      type: 'terminal_attach',
      id: this.#nextId('attach'),
      payload: {
        session_id: this.#sessionId,
        terminal_id: this.#terminalId,
        since_seq: since,
      },
    });
  }

  protected onFrame(frame: ServerFrame): void {
    // The attach ACK marks the stream as live; on (re)connect the owner wires
    // input forwarding and knows replay completed. Input/resize ACKs are noop.
    if (!this.#attached && frame.type === 'ack') {
      const payload = frame.payload as { attached?: unknown; replayed?: unknown } | undefined;
      if (payload?.attached === true) {
        this.#attached = true;
        this.#handlers.onAttached(typeof payload.replayed === 'number' ? payload.replayed : 0);
        this.#handlers.onReconnected();
        return;
      }
    }
    switch (frame.type) {
      case 'terminal_output': {
        if (frame.session_id !== this.#sessionId || frame.terminal_id !== this.#terminalId) return;
        const payload = frame.payload as { data?: unknown } | undefined;
        const data = payload?.data;
        const seq = typeof frame.seq === 'number' ? frame.seq : 0;
        if (typeof data === 'string') this.#handlers.onOutput(data, seq);
        return;
      }
      case 'terminal_exit': {
        if (frame.session_id !== this.#sessionId || frame.terminal_id !== this.#terminalId) return;
        const exitCode = (frame.payload as { exit_code?: unknown } | undefined)?.exit_code;
        this.#handlers.onExit(
          typeof exitCode === 'number' ? exitCode : exitCode === null ? null : undefined,
        );
        return;
      }
      default:
        // server_hello / other acks — not consumed.
        return;
    }
  }

  /** Send keyboard input to the PTY (best-effort while attached). */
  sendInput(data: string): void {
    if (!this.#attached) return;
    this.send({
      type: 'terminal_input',
      id: this.#nextId('input'),
      payload: { session_id: this.#sessionId, terminal_id: this.#terminalId, data },
    });
  }

  /** Resize the PTY (cols/rows); the owner throttles this. */
  sendResize(cols: number, rows: number): void {
    if (!this.#attached) return;
    this.send({
      type: 'terminal_resize',
      id: this.#nextId('resize'),
      payload: { session_id: this.#sessionId, terminal_id: this.#terminalId, cols, rows },
    });
  }
}
