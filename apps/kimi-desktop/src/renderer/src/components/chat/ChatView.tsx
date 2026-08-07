/**
 * ChatView — the conversation of the active session, rendered from the
 * transcript surface (`/api/v1`).
 *
 * Data flow (the standard zero-gap rebuild path, see `lib/transcriptSync.ts`):
 * full state comes from REST (`GET .../transcript` newest page, replace);
 * `GET /api/v1/ws` is a delta channel only (`transcript.ops`, grade `block`)
 * applied onto the same `TranscriptChatStore`; seq gaps / `resync_required` /
 * reconnect acks trigger point-to-point catch-up with a full-refresh fallback;
 * older history pages with `before_turn`. Interaction answers (approvals /
 * questions) go through the REST endpoints.
 *
 * One (store, sync) pair is cached per session id and reused across switches
 * (the WS subscription is torn down on leave and re-established on return, so
 * transcript state survives session switches without a reload).
 */

import {
  approvalRequestSchema,
  questionRequestSchema,
  type ApprovalDecision,
  type ApprovalScope,
  type QuestionResponse,
} from '@moonshot-ai/protocol';
import {
  EMPTY_AGENT_STATE,
  type TranscriptInteraction,
} from '@moonshot-ai/transcript';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { useConnection } from '#/lib/connection';
import {
  useDismissQuestion,
  useResolveApproval,
  useResolveQuestion,
} from '#/lib/queries';
import { TranscriptChatStore } from '#/lib/transcript/chatStore';
import { TranscriptSync } from '#/lib/transcriptSync';

import { Timeline } from './Timeline';
import { TodoPanel } from './TodoPanel';
import { Composer } from '../composer/Composer';

export interface ChatViewProps {
  readonly sessionId: string;
  /** Agent whose transcript this view renders; defaults to the main agent.
   *  Side-channel (btw) panels pass the `agent-<N>` returned by `:btw`. */
  readonly agentId?: string;
}

/** Imperative surface for the app shell (session actions): force a full REST
 *  baseline refresh after destructive actions like undo. */
export interface ChatViewHandle {
  refresh(): void;
}

interface Channel {
  readonly store: TranscriptChatStore;
  readonly sync: TranscriptSync;
}

const noopSubscribe = () => () => {};

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView(
  { sessionId, agentId = 'main' },
  ref,
) {
  const { api } = useConnection();
  /** Per (session, agent) channels, kept across switches (teardown only on unmount). */
  const channelsRef = useRef<Map<string, Channel>>(new Map());
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [olderError, setOlderError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [interactionError, setInteractionError] = useState<unknown>(null);

  useEffect(() => {
    const channels = channelsRef.current;
    const channelKey = `${sessionId}:${agentId}`;
    let entry = channels.get(channelKey);
    if (entry === undefined) {
      const store = new TranscriptChatStore();
      const sync = new TranscriptSync({
        api,
        sessionId,
        agentId,
        store,
        onLoadState: ({ loaded: nextLoaded, error }) => {
          setLoaded(nextLoaded);
          setLoadError(error);
        },
      });
      entry = { store, sync };
      channels.set(channelKey, entry);
      setLoaded(false);
      setLoadError(null);
    } else {
      // Cached channel: restore its load state so the UI does not flash a
      // loading screen before the refresh below settles.
      setLoaded(entry.sync.loaded);
      setLoadError(entry.sync.loadError);
    }
    setChannel(entry);
    setOlderError(null);
    entry.sync.start();
    return () => {
      entry.sync.stop();
      setChannel(null);
    };
  }, [api, sessionId, agentId]);

  // Expose the refresh trigger for the app shell's session actions (undo).
  useImperativeHandle(
    ref,
    () => ({
      refresh: () => channel?.sync.refresh(),
    }),
    [channel],
  );

  // On unmount tear every cached channel down (WS subscriptions included).
  useEffect(() => {
    const channels = channelsRef.current;
    return () => {
      for (const { sync } of channels.values()) sync.stop();
      channels.clear();
    };
  }, []);

  const state = useSyncExternalStore(
    channel?.store.subscribe ?? noopSubscribe,
    () => channel?.store.getState() ?? EMPTY_AGENT_STATE,
  );

  const running =
    state.meta.activity === 'turn' ||
    state.items.some((item) => item.kind === 'turn' && item.state === 'running');

  const resolveApproval = useResolveApproval(sessionId);
  const resolveQuestion = useResolveQuestion(sessionId);
  const dismissQuestion = useDismissQuestion(sessionId);

  const handleResolveApproval = useCallback(
    (
      interaction: TranscriptInteraction,
      decision: ApprovalDecision,
      options?: { scope?: ApprovalScope; feedback?: string; selectedLabel?: string },
    ) => {
      const parsed = approvalRequestSchema.safeParse(interaction.request);
      if (!parsed.success) return;
      setInteractionError(null);
      // Returns the in-flight promise so the card can keep its busy state
      // until the answer lands. `selectedLabel`/`feedback` ride the body for
      // plan-review answers; the engine records them on the interaction.
      return resolveApproval
        .mutateAsync({
          approvalId: parsed.data.approval_id,
          body: {
            decision,
            scope: options?.scope,
            feedback: options?.feedback,
            selected_label: options?.selectedLabel,
          },
        })
        .catch(setInteractionError)
        .then(() => undefined);
    },
    [resolveApproval],
  );

  const handleAnswerQuestion = useCallback(
    (interaction: TranscriptInteraction, response: QuestionResponse) => {
      const parsed = questionRequestSchema.safeParse(interaction.request);
      if (!parsed.success) return;
      setInteractionError(null);
      return resolveQuestion
        .mutateAsync({ questionId: parsed.data.question_id, body: response })
        .catch(setInteractionError)
        .then(() => undefined);
    },
    [resolveQuestion],
  );

  const handleDismissQuestion = useCallback(
    (interaction: TranscriptInteraction) => {
      const parsed = questionRequestSchema.safeParse(interaction.request);
      if (!parsed.success) return;
      setInteractionError(null);
      return dismissQuestion
        .mutateAsync(parsed.data.question_id)
        .catch(setInteractionError)
        .then(() => undefined);
    },
    [dismissQuestion],
  );

  const loadOlder = useCallback(() => {
    const sync = channel?.sync;
    if (sync === undefined || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    void sync
      .loadOlder()
      .catch(setOlderError)
      .finally(() => setLoadingOlder(false));
  }, [channel, loadingOlder]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <ConnectionBar
        loaded={loaded}
        error={loadError}
        running={running}
        pendingCount={state.pendingInteractions.size}
      />
      {interactionError !== null ? (
        <div className="mx-auto mt-2 w-[calc(100%-2.5rem)] max-w-[46rem] rounded-xl border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--red-500)_6%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text-danger)]">
          操作没有完成，请重试。
        </div>
      ) : null}
      <Timeline
        state={state}
        loading={!loaded}
        error={loadError ?? olderError}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        onResolveApproval={handleResolveApproval}
        onAnswerQuestion={handleAnswerQuestion}
        onDismissQuestion={handleDismissQuestion}
      />
      <TodoPanel todos={state.todos} />
      <Composer sessionId={sessionId} agentId={agentId} />
    </div>
  );
});

/** Slim status line: connection/sync state, the active turn, pending
 *  interactions. */
function ConnectionBar({
  loaded,
  error,
  running,
  pendingCount,
}: {
  loaded: boolean;
  error: unknown;
  running: boolean;
  pendingCount: number;
}) {
  const failed = error !== null;
  const dot = failed
    ? 'bg-[var(--red-500)]'
    : loaded
      ? 'bg-[var(--green-500)]'
      : 'bg-[var(--orange-400)]';
  const label = failed ? '同步失败' : loaded ? '已同步' : '同步中…';
  return (
    <div className="flex min-h-[28px] items-center justify-end gap-2 px-5 py-1 text-[10.5px] text-[var(--color-text-secondary)]">
      <span className="flex shrink-0 items-center gap-3">
        {running ? <span className="text-[var(--orange-400)]">● 运行中</span> : null}
        {pendingCount > 0 ? <span className="text-[var(--orange-400)]">{pendingCount} 待处理</span> : null}
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot} ${!failed && loaded ? '' : 'animate-pulse'}`} />
          {label}
        </span>
      </span>
    </div>
  );
}
