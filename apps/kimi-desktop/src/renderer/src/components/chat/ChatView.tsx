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
import { approvalInteractionPresentation } from '#/lib/approvalInteraction';
import {
  useAbortPrompt,
  useDismissQuestion,
  usePendingSessionInteractions,
  useResolveApproval,
  useResolveQuestion,
  useSession,
} from '#/lib/queries';
import {
  projectAgentPendingInteractions,
  type SourcedPendingInteraction,
} from '#/lib/sessionInteractions';
import {
  pendingComposerInteractions,
  shouldAbortAfterApproval,
} from '#/lib/timelinePresentation';
import { TranscriptChatStore } from '#/lib/transcript/chatStore';
import { TranscriptSync } from '#/lib/transcriptSync';

import { Timeline } from './Timeline';
import { TodoPanel } from './TodoPanel';
import { Composer } from '../composer/Composer';
import { ApprovalCard, type ApprovalResolveOptions } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';

export interface ChatViewProps {
  readonly sessionId: string;
  readonly onSwitchWorkspace?: (cwd: string) => void;
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
  { sessionId, agentId = 'main', onSwitchWorkspace },
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
  const abortPrompt = useAbortPrompt(sessionId);
  const sessionQuery = useSession(sessionId);
  const pendingQuery = usePendingSessionInteractions(sessionId);
  const transcriptFallback = projectAgentPendingInteractions(state.interactions, agentId);
  const pendingInteractions = pendingQuery.data ?? transcriptFallback;
  const pendingInteraction = pendingComposerInteractions(pendingInteractions)[0];

  const handleResolveApproval = useCallback(
    (
      interaction: TranscriptInteraction,
      decision: ApprovalDecision,
      options?: { scope?: ApprovalScope; feedback?: string; selectedLabel?: string },
      sourceAgentId = 'main',
    ) => {
      const approval = approvalInteractionPresentation(interaction);
      setInteractionError(null);
      // Returns the in-flight promise so the card can keep its busy state
      // until the answer lands. `selectedLabel`/`feedback` ride the body for
      // plan-review answers; the engine records them on the interaction.
      const promptId = sessionQuery.data?.current_prompt_id;
      return resolveApproval
        .mutateAsync({
          approvalId: approval.approvalId,
          body: {
            decision,
            scope: options?.scope,
            feedback: options?.feedback,
            selected_label: options?.selectedLabel,
          },
        })
        .then(async () => {
          if (
            shouldAbortAfterApproval(decision, options?.selectedLabel, sourceAgentId) &&
            promptId !== undefined
          ) {
            // The engine may finish the rejected call between the resolve and
            // abort requests. That already satisfies the terminal outcome, so
            // treat an abort race as a no-op instead of surfacing a second UI
            // error after the user's rejection succeeded.
            await abortPrompt.mutateAsync(promptId).catch(() => undefined);
          }
        })
        .catch(setInteractionError)
        .then(() => undefined);
    },
    [resolveApproval, abortPrompt, sessionQuery.data?.current_prompt_id],
  );

  const handleAnswerQuestion = useCallback(
    (interaction: TranscriptInteraction, response: QuestionResponse) => {
      setInteractionError(null);
      // The transcript carries the in-process request (no wire question_id);
      // the REST `:question_id` is the interaction id, which the server matches
      // against `interaction.id` (see routes/questions.ts).
      return resolveQuestion
        .mutateAsync({ questionId: interaction.interactionId, body: response })
        .catch(setInteractionError)
        .then(() => undefined);
    },
    [resolveQuestion],
  );

  const handleDismissQuestion = useCallback(
    (interaction: TranscriptInteraction) => {
      setInteractionError(null);
      return dismissQuestion
        .mutateAsync(interaction.interactionId)
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

  const retryInitialLoad = useCallback(() => {
    setLoadError(null);
    channel?.sync.refresh();
  }, [channel]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <ConnectionBar
        error={loadError ?? pendingQuery.error}
        running={running}
        pendingCount={pendingInteractions.length}
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
        onRetry={retryInitialLoad}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        pendingSessionInteractions={pendingInteractions}
      />
      <TodoPanel todos={state.todos} />
      {/* Empty headline sits directly above the composer so they read as one unit. */}
      {loaded && state.items.length === 0 ? <EmptyComposerHero /> : null}
      {pendingInteraction !== undefined ? (
        <PendingInteractionDock
          pending={pendingInteraction}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
        />
      ) : null}
      {loadError !== null && !loaded ? null : (
        <Composer
          sessionId={sessionId}
          agentId={agentId}
          empty={loaded && state.items.length === 0}
          onSwitchWorkspace={onSwitchWorkspace}
        />
      )}
    </div>
  );
});

function PendingInteractionDock({
  pending,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  readonly pending: SourcedPendingInteraction;
  readonly onResolveApproval: (
    interaction: TranscriptInteraction,
    decision: ApprovalDecision,
    options?: ApprovalResolveOptions,
    sourceAgentId?: string,
  ) => void | Promise<void>;
  readonly onAnswerQuestion: (
    interaction: TranscriptInteraction,
    response: QuestionResponse,
  ) => void | Promise<void>;
  readonly onDismissQuestion: (interaction: TranscriptInteraction) => void | Promise<void>;
}) {
  const { interaction, sourceAgentId } = pending;
  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-6 pb-2">
      <div className="max-h-[34vh] overflow-y-auto rounded-2xl shadow-[var(--shadow-md)]">
        {sourceAgentId !== 'main' ? (
          <div className="border-b border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-1.5 text-[10.5px] font-medium text-[var(--color-text-secondary)]">
            来自子 Agent · {sourceAgentId}
          </div>
        ) : null}
        {interaction.interactionKind === 'approval' ? (
          <ApprovalCard
            interaction={interaction}
            onResolve={(decision, options) =>
              onResolveApproval(interaction, decision, options, sourceAgentId)
            }
          />
        ) : (
          <QuestionCard
            interaction={interaction}
            onAnswer={(response) => onAnswerQuestion(interaction, response)}
            onDismiss={() => onDismissQuestion(interaction)}
          />
        )}
      </div>
    </div>
  );
}

/** Empty-session hero: purpose line paired with the composer below it. */
function EmptyComposerHero() {
  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-6 pb-2 pt-2 text-center">
      <div className="text-[22px] font-semibold tracking-[var(--tracking-display)] text-[var(--color-text-foreground)]">
        今天想做什么？
      </div>
      <p className="mt-1.5 text-[13px] leading-5 tracking-[var(--tracking-tight)] text-[var(--color-text-secondary)]">
        描述你的任务，或用 + 添加文件作为上下文。
      </p>
    </div>
  );
}

/** Slim status line: connection/sync state, the active turn, pending
 *  interactions. */
function ConnectionBar({
  error,
  running,
  pendingCount,
}: {
  error: unknown;
  running: boolean;
  pendingCount: number;
}) {
  const failed = error !== null;
  if (!running && pendingCount === 0 && !failed) return null;
  return (
    <div className="flex min-h-[28px] items-center justify-end gap-2 px-5 py-1 text-[10.5px] text-[var(--color-text-secondary)]">
      <span className="flex shrink-0 items-center gap-3">
        {running ? (
          <span className="flex items-center gap-1.5 text-[var(--orange-400)]">
            <span className="ui-dot-pulse h-1.5 w-1.5 bg-current" aria-hidden />
            运行中
          </span>
        ) : null}
        {pendingCount > 0 ? <span className="text-[var(--orange-400)]">{pendingCount} 待处理</span> : null}
        {failed ? <span className="text-[var(--color-text-danger)]">同步失败</span> : null}
      </span>
    </div>
  );
}
