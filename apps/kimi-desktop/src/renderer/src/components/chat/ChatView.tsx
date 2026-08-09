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
  type TranscriptTask,
  type TranscriptTodo,
} from '@moonshot-ai/transcript';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { useConnection } from '#/lib/connection';
import type { TranscriptPlanInfo } from '#/lib/api';
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
import { todosFromTimeline } from './TodoPanel';
import { Composer } from '../composer/Composer';
import { ApprovalCard, parsePlanReview, type ApprovalResolveOptions } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';
import type { OpenPlanDoc } from './PlanDocViewer';

export interface ChatViewProps {
  readonly sessionId: string;
  /** Agent whose transcript this view renders; defaults to the main agent.
   *  Side-channel (btw) panels pass the `agent-<N>` returned by `:btw`. */
  readonly agentId?: string;
  /** Open a child agent's transcript in the side panel (swarm / Agent calls). */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
  /** Parent-agent brief shown as the first block of a child transcript. */
  readonly introPrompt?: string;
  /** Report the live plan-panel summary (main agent only); `undefined` on
   *  unmount so the shell can drop the stale snapshot. */
  readonly onTranscriptSummary?: (summary: TranscriptSummary | undefined) => void;
  readonly onOpenModelSettings?: () => void;
}

/** The live transcript slice the app shell's plan panel renders — plans, the
 *  TodoList execution progress, child-agent tasks — plus whether a plan
 *  review is currently awaiting an answer (drives the panel auto-switch). */
export interface TranscriptSummary {
  readonly plans: ReadonlyMap<string, TranscriptPlanInfo>;
  readonly todos: ReadonlyMap<string, TranscriptTodo>;
  readonly tasks: ReadonlyMap<string, TranscriptTask>;
  readonly pendingPlanReview: boolean;
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
  {
    sessionId,
    agentId = 'main',
    onOpenAgent,
    onOpenPlanDoc,
    introPrompt,
    onTranscriptSummary,
    onOpenModelSettings,
  },
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
  const [plans, setPlans] = useState<ReadonlyMap<string, TranscriptPlanInfo>>(() => new Map());

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

  // The plan endpoint projects both live approval displays and cold-replay
  // output. It fills the gap left by historical ExitPlanMode frames whose
  // ephemeral `display` payload was never persisted.
  useEffect(() => {
    let cancelled = false;
    setPlans(new Map());
    void api
      .transcriptPlan(sessionId, agentId)
      .then((entries) => {
        if (!cancelled) setPlans(new Map(entries.map((entry) => [entry.toolCallId, entry])));
      })
      .catch(() => {
        // Older kap-server instances do not expose the projection route. The
        // frame-local parser remains available as a graceful fallback.
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, agentId]);

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
  const panelTodos = useMemo(
    () => (state.todos.size > 0 ? state.todos : todosFromTimeline(state.items)),
    [state.todos, state.items],
  );
  const isSideAgent = agentId !== 'main';

  // Report the plan-panel slice to the app shell (main agent only; side-agent
  // ChatViews share the session but must not overwrite the main summary).
  const pendingPlanReview =
    pendingInteraction !== undefined &&
    pendingInteraction.interaction.interactionKind === 'approval' &&
    parsePlanReview(approvalInteractionPresentation(pendingInteraction.interaction).display) !== undefined;
  const summaryCallbackRef = useRef(onTranscriptSummary);
  useEffect(() => {
    summaryCallbackRef.current = onTranscriptSummary;
  }, [onTranscriptSummary]);
  useEffect(() => {
    if (isSideAgent) return;
    summaryCallbackRef.current?.({
      plans,
      todos: panelTodos,
      tasks: state.tasks,
      pendingPlanReview,
    });
  }, [isSideAgent, plans, panelTodos, state.tasks, pendingPlanReview]);
  useEffect(() => {
    if (isSideAgent) return;
    return () => summaryCallbackRef.current?.(undefined);
  }, [isSideAgent]);

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
      {isSideAgent ? null : (
        <ConnectionBar
          error={loadError ?? pendingQuery.error}
          running={running}
          pendingCount={pendingInteractions.length}
        />
      )}
      {interactionError !== null ? (
        <div className="mx-auto mt-2 w-[calc(100%-2.5rem)] max-w-[46rem] rounded-[var(--radius-md)] border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--color-text-danger)_6%,transparent)] px-3 py-2 text-[12px] text-[var(--color-text-danger)]">
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
        onOpenAgent={onOpenAgent}
        onOpenPlanDoc={onOpenPlanDoc}
        plans={plans}
        variant={isSideAgent ? 'agent' : 'main'}
        introPrompt={introPrompt}
      />
      {/* Empty headline sits directly above the composer so they read as one unit. */}
      {!isSideAgent && loaded && state.items.length === 0 ? <EmptyComposerHero /> : null}
      {!isSideAgent && pendingInteraction !== undefined ? (
        <PendingInteractionDock
          pending={pendingInteraction}
          onResolveApproval={handleResolveApproval}
          onAnswerQuestion={handleAnswerQuestion}
          onDismissQuestion={handleDismissQuestion}
          onOpenPlanDoc={onOpenPlanDoc}
        />
      ) : null}
      {isSideAgent || (loadError !== null && !loaded) ? null : (
        <Composer
          sessionId={sessionId}
          agentId={agentId}
          empty={loaded && state.items.length === 0}
          onOpenModelSettings={onOpenModelSettings}
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
  onOpenPlanDoc,
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
  readonly onOpenPlanDoc?: OpenPlanDoc;
}) {
  const { interaction, sourceAgentId } = pending;
  return (
    <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-6 pb-2">
      <div className="max-h-[34vh] overflow-y-auto rounded-[var(--radius-lg)] shadow-[var(--shadow-md)]">
        {sourceAgentId !== 'main' ? (
          <div className="flex items-center gap-2 border-b border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-1.5 text-[10.5px] font-medium text-[var(--color-text-secondary)]">
            <span className="rounded-full bg-[var(--color-accent-background)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-accent-text)]">
              {sourceAgentId}
            </span>
            <span>请求需要你的回应</span>
          </div>
        ) : null}
        {interaction.interactionKind === 'approval' ? (
          <ApprovalCard
            interaction={interaction}
            onResolve={(decision, options) =>
              onResolveApproval(interaction, decision, options, sourceAgentId)
            }
            onOpenPlanDoc={onOpenPlanDoc}
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
          <span className="flex items-center gap-1.5 text-[var(--color-text-warning)]">
            <span className="ui-dot-pulse h-1.5 w-1.5 bg-current" aria-hidden />
            运行中
          </span>
        ) : null}
        {pendingCount > 0 ? <span className="text-[var(--color-text-warning)]">{pendingCount} 待处理</span> : null}
        {failed ? <span className="text-[var(--color-text-danger)]">同步失败</span> : null}
      </span>
    </div>
  );
}
