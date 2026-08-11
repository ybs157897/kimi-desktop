import type {
  ToolCallFrame,
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';
import type { QuestionResponse } from '@moonshot-ai/protocol';
import { CaretRight } from '@phosphor-icons/react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';

import type { TranscriptPlanInfo } from '#/lib/api';
import type { SourcedPendingInteraction } from '#/lib/sessionInteractions';
import {
  liveTailFrameId,
  pendingInteractionForToolFrame,
  resultTextFrameId,
  taskForToolFrame,
} from '#/lib/timelinePresentation';
import { toolRunsFromTurn } from '#/lib/toolRunsFromTurn';

import { ApprovalCard, type ApprovalResolveHandler } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';
import { AttachmentThumbnails } from './attachments/AttachmentThumbnails';
import { EditedFilesCard } from './EditedFilesCard';
import { TurnContext } from './frameContext';
import { NoticeFrame } from './frames/NoticeFrame';
import { TextFrame } from './frames/TextFrame';
import { ThinkingFrame } from './frames/ThinkingFrame';
import { ToolFrame } from './frames/ToolFrame';
import { ToolRunCard } from './frames/ToolRunCard';
import { SubagentActivityRow } from './frames/SubagentActivityRow';
import type { SourcedChildInteraction } from './frames/SwarmCard';
import type { OpenPlanDoc } from './PlanDocViewer';

export interface TurnBlockProps {
  readonly turn: TranscriptTurn;
  readonly tasks?: ReadonlyMap<string, TranscriptTask>;
  readonly interactions?: ReadonlyMap<string, TranscriptInteraction>;
  readonly attachments?: ReadonlyMap<string, TranscriptAttachment>;
  readonly pendingSessionInteractions?: readonly SourcedPendingInteraction[];
  readonly onResolveApproval?: ApprovalResolveHandler;
  readonly onAnswerQuestion?: (
    interaction: TranscriptInteraction,
    response: QuestionResponse,
  ) => void | Promise<void>;
  readonly onDismissQuestion?: (interaction: TranscriptInteraction) => void | Promise<void>;
  /** Open a child agent's transcript in the side panel (swarm / single Agent). */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open the session-level child-agent summary in the right panel. */
  readonly onOpenSubagents?: () => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
  readonly plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  readonly hidePrompt?: boolean;
}

/** One turn: prompt + steps, each step's frames dispatched to their frame
 *  components. Interactions anchored to a tool call render inline at that
 *  frame. The turn's lifecycle facts ride `TurnContext` so leaf frames can
 *  render streaming / elapsed labels without widened props. */
export function TurnBlock({
  turn,
  tasks,
  interactions,
  attachments,
  pendingSessionInteractions = [],
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenSubagents,
  onOpenPlanDoc,
  plans,
  hidePrompt = false,
}: TurnBlockProps) {
  // Live turns keep streaming tool calls / thinking visible without a second
  // process header. Once settled, the disclosure appears collapsed unless the
  // user explicitly toggles it (ThinkingFrame idiom).
  const [userExpanded, setUserExpanded] = useState<boolean | undefined>(undefined);
  const live = turn.state === 'queued' || turn.state === 'running';
  const processExpanded = userExpanded ?? live;
  const resultFrameId = resultTextFrameId(turn);
  const processFrameCount = turn.steps.reduce(
    (count, step) =>
      count + step.frames.filter((frame) => frame.frameId !== resultFrameId).length,
    0,
  );

  return (
    <section className="mb-4 last:mb-1">
      {!hidePrompt && turn.prompt !== undefined && turn.prompt !== '' ? <TurnPrompt turn={turn} /> : null}
      {turn.attachmentIds !== undefined && turn.attachmentIds.length > 0 ? (
        <AttachmentThumbnails ids={turn.attachmentIds} attachments={attachments} />
      ) : null}
      <TurnContext.Provider
        value={{
          state: turn.state,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          durationMs: turn.durationMs,
          liveTailFrameId: liveTailFrameId(turn),
        }}
      >
        {!live && processFrameCount > 0 ? (
          <ProcessDisclosure
            expanded={processExpanded}
            durationMs={turn.durationMs}
            onToggle={() => setUserExpanded((value) => !(value ?? false))}
          />
        ) : null}
        {/* A live turn always mounts the timeline so streaming frames land
            visibly; a settled turn only mounts it when there is something to
            show (process frames or a result). While a live turn has neither,
            a quiet "Thinking" shimmer keeps the user oriented instead of a
            blank gap. */}
        {processFrameCount > 0 || resultFrameId !== undefined || live ? (
          <FlattenedTimeline
            turn={turn}
            tasks={tasks}
            interactions={interactions}
            attachments={attachments}
            pendingSessionInteractions={pendingSessionInteractions}
            onResolveApproval={onResolveApproval}
            onAnswerQuestion={onAnswerQuestion}
            onDismissQuestion={onDismissQuestion}
            onOpenAgent={onOpenAgent}
            onOpenSubagents={onOpenSubagents}
            onOpenPlanDoc={onOpenPlanDoc}
            plans={plans}
            processExpanded={processExpanded}
            resultFrameId={resultFrameId}
            live={live}
          />
        ) : null}
      </TurnContext.Provider>
      <EditedFilesCard turn={turn} />
      {turn.state === 'failed' && turn.error !== undefined ? (
        <div
          className="ui-card-enter mb-2 max-w-[46rem] border-l-[3px] py-1.5 pl-3 pr-2 text-[12px] text-[var(--color-text-danger)]"
          style={{ borderLeftColor: 'var(--color-text-danger)' }}
        >
          {turn.error}
        </div>
      ) : null}
    </section>
  );
}

function ProcessDisclosure({
  expanded,
  durationMs,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly durationMs?: number;
  readonly onToggle: () => void;
}) {
  const label = `已处理${durationMs !== undefined ? ` ${formatDuration(durationMs)}` : ''}`;
  return (
    <div className="mb-2 flex max-w-[46rem] items-center gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="ui-pressable -ml-1 flex shrink-0 cursor-pointer select-none items-center gap-1 rounded-[var(--radius-xs)] px-1 py-1 text-[length:var(--codex-chat-font-size)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)]"
      >
        <CaretRight
          size={12}
          weight="bold"
          className={`transition-transform duration-[var(--duration-hover)] ${expanded ? 'rotate-90' : ''}`}
          aria-hidden
        />
        <span>{label}</span>
      </button>
      <div className="h-px min-w-0 flex-1 bg-[var(--color-border-light)]" aria-hidden />
    </div>
  );
}

function TurnPrompt({ turn }: { turn: TranscriptTurn }) {
  if (turn.origin.kind === 'user') {
    return (
      <div className="ui-card-enter mb-3 flex justify-end">
        <div className="max-w-[min(80%,36rem)] rounded-[var(--radius-lg)] bg-[var(--color-user-bubble)] px-3.5 py-2.5 shadow-[var(--shadow-sm)]">
          <div className="whitespace-pre-wrap text-[length:var(--client-content-font-size)] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
            {turn.prompt}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ui-card-enter mb-3 max-w-[46rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3.5 py-2.5">
      <div className="ui-label mb-1">{turn.origin.kind}</div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-[var(--leading-chat)] text-[var(--color-text-secondary)]">
        {turn.prompt}
      </div>
    </div>
  );
}

/** A live turn's quiet "Thinking" placeholder (Codex `Ex` parity): a single
 *  shimmering line shown while the engine has not yet produced any frame, so
 *  the gap between sending a prompt and the first delta is never blank. */
function LiveThinkingPlaceholder() {
  return (
    <div className="ui-shimmer-text mb-1 max-w-[46rem] text-[length:var(--codex-chat-font-size)] leading-[var(--markdown-line-height,calc(var(--codex-chat-font-size,14px)+8px))]">
      正在思考…
    </div>
  );
}

/**
 * FlattenedTimeline — renders a turn's frames as the Codex-style activity
 * projection: consecutive groupable tool calls collapse into a single
 * {@link ToolRunCard} summary row, Agent calls become one compact chip row,
 * and remaining standalone frames (thinking, text, notice, plan, search,
 * todo) render on their own. Step boundaries are flattened by walking
 * {@link toolRunsFromTurn}'s projection. */
function FlattenedTimeline({
  turn,
  tasks,
  interactions,
  attachments,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenSubagents,
  onOpenPlanDoc,
  plans,
  processExpanded,
  resultFrameId,
  live,
}: {
  turn: TranscriptTurn;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  onOpenAgent?: (agentId: string, prompt?: string) => void;
  onOpenSubagents?: () => void;
  onOpenPlanDoc?: OpenPlanDoc;
  plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  processExpanded: boolean;
  resultFrameId?: string;
  live: boolean;
}) {
  const entries = toolRunsFromTurn(turn);
  const stepDurationByFrame = useMemo(() => {
    const map = new Map<string, number>();
    for (const step of turn.steps) {
      const duration = elapsedBetween(step.startedAt, step.endedAt);
      if (duration === undefined) continue;
      for (const frame of step.frames) map.set(frame.frameId, duration);
    }
    return map;
  }, [turn]);
  const interrupted = processExpanded && turn.steps.some((step) => step.state === 'interrupted');
  // A live turn that has not produced any frames yet shows a quiet "Thinking"
  // shimmer so the gap is never a blank stare (Codex `Ex` placeholder parity).
  const awaitingFirstFrame = live && entries.length === 0 && resultFrameId === undefined;

  return (
    <div>
      {awaitingFirstFrame ? <LiveThinkingPlaceholder /> : null}
      {entries.map((entry, index) => {
        if (entry.kind === 'subagents') {
          const runKey = entry.frames[0]?.frameId ?? String(index);
          return (
            <Fragment key={`subagents-${runKey}`}>
              {processExpanded ? (
                <SubagentActivityRow
                  frames={entry.frames}
                  tasks={tasks}
                  onOpenAgent={onOpenAgent}
                  onOpenSubagents={onOpenSubagents}
                />
              ) : null}
              {entry.frames.map((frame) => (
                <ToolPendingInteractionNode
                  key={`pending-${frame.frameId}`}
                  frame={frame}
                  interactions={interactions}
                  pendingSessionInteractions={pendingSessionInteractions}
                  onResolveApproval={onResolveApproval}
                  onAnswerQuestion={onAnswerQuestion}
                  onDismissQuestion={onDismissQuestion}
                  onOpenPlanDoc={onOpenPlanDoc}
                />
              ))}
            </Fragment>
          );
        }
        if (entry.kind === 'run') {
          // Frames inside a run are always built (visible=true): ToolRunCard's
          // own CollapsibleBody controls whether they are physically on screen
          // (run expanded) or hidden behind the summary (run collapsed). They
          // must not be gated by `processExpanded` too, or expanding a run
          // inside an already-expanded process section would still show nothing.
          const runKey = entry.frames[0]?.frameId ?? String(index);
          return (
            <Fragment key={`run-${runKey}`}>
              <ToolRunCard run={entry}>
                {entry.frames.map((frame) => (
                  <ToolFrameNode
                    key={frame.frameId}
                    frame={frame}
                    tasks={tasks}
                    interactions={interactions}
                    pendingSessionInteractions={pendingSessionInteractions}
                    onResolveApproval={onResolveApproval}
                    onAnswerQuestion={onAnswerQuestion}
                    onDismissQuestion={onDismissQuestion}
                    onOpenAgent={onOpenAgent}
                    onOpenPlanDoc={onOpenPlanDoc}
                    plans={plans}
                    visible
                    showPendingInteraction={false}
                  />
                ))}
              </ToolRunCard>
              {entry.frames.map((frame) => (
                <ToolPendingInteractionNode
                  key={`pending-${frame.frameId}`}
                  frame={frame}
                  interactions={interactions}
                  pendingSessionInteractions={pendingSessionInteractions}
                  onResolveApproval={onResolveApproval}
                  onAnswerQuestion={onAnswerQuestion}
                  onDismissQuestion={onDismissQuestion}
                  onOpenPlanDoc={onOpenPlanDoc}
                />
              ))}
            </Fragment>
          );
        }
        const frame = entry.frame;
        const visible = processExpanded || frame.frameId === resultFrameId;
        return (
          <FrameView
            key={frame.frameId}
            frame={frame}
            stepDurationMs={stepDurationByFrame.get(frame.frameId)}
            tasks={tasks}
            interactions={interactions}
            attachments={attachments}
            pendingSessionInteractions={pendingSessionInteractions}
            onResolveApproval={onResolveApproval}
            onAnswerQuestion={onAnswerQuestion}
            onDismissQuestion={onDismissQuestion}
            onOpenAgent={onOpenAgent}
            onOpenPlanDoc={onOpenPlanDoc}
            plans={plans}
            visible={visible}
          />
        );
      })}
      {interrupted ? (
        <div className="mb-2 px-0.5 text-[10px] italic text-[var(--color-text-tertiary)]">
          步骤已中断
        </div>
      ) : null}
    </div>
  );
}

/** A tool frame rendered as a fragment (the ToolRunCard owns the wrapper). */
function ToolFrameNode({
  frame,
  tasks,
  interactions,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenPlanDoc,
  plans,
  visible,
  showPendingInteraction = true,
}: {
  frame: ToolCallFrame;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  onOpenAgent?: (agentId: string, prompt?: string) => void;
  onOpenPlanDoc?: OpenPlanDoc;
  plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  visible: boolean;
  showPendingInteraction?: boolean;
}) {
  const interaction =
    findInteraction(frame.toolCallId, frame.approvalId, interactions) ??
    pendingInteractionForToolFrame(frame, pendingSessionInteractions)?.interaction;
  const task = taskForToolFrame(frame, tasks);
  const childInteractions = childInteractionsForFrame(frame, pendingSessionInteractions);
  const pending =
    interaction !== undefined && interaction.state === 'pending'
      ? renderInteraction(interaction, {
          onResolveApproval,
          onAnswerQuestion,
          onDismissQuestion,
          onOpenPlanDoc,
        })
      : null;
  return (
    <>
      {visible ? (
        <ToolFrame
          frame={frame}
          task={task}
          interaction={interaction}
          tasks={tasks}
          childInteractions={childInteractions}
          onOpenAgent={onOpenAgent}
          onOpenPlanDoc={onOpenPlanDoc}
          plan={plans?.get(frame.toolCallId)}
        />
      ) : null}
      {showPendingInteraction ? pending : null}
    </>
  );
}

/** Pending approval/question cards must remain actionable even while the
 *  command rows themselves are folded into one live activity line. */
function ToolPendingInteractionNode({
  frame,
  interactions,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenPlanDoc,
}: {
  frame: ToolCallFrame;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  onOpenPlanDoc?: OpenPlanDoc;
}) {
  const interaction =
    findInteraction(frame.toolCallId, frame.approvalId, interactions) ??
    pendingInteractionForToolFrame(frame, pendingSessionInteractions)?.interaction;
  if (interaction?.state !== 'pending') return null;
  return renderInteraction(interaction, {
    onResolveApproval,
    onAnswerQuestion,
    onDismissQuestion,
    onOpenPlanDoc,
  });
}

function FrameView({
  frame,
  stepDurationMs,
  tasks,
  interactions,
  attachments,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenPlanDoc,
  plans,
  visible,
}: {
  frame: TranscriptFrame;
  stepDurationMs?: number;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  onOpenAgent?: (agentId: string, prompt?: string) => void;
  onOpenPlanDoc?: OpenPlanDoc;
  plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  visible: boolean;
}) {
  switch (frame.kind) {
    case 'text':
      return visible ? <TextFrame frame={frame} attachments={attachments} /> : null;
    case 'thinking':
      return visible ? <ThinkingFrame frame={frame} durationMs={stepDurationMs} /> : null;
    case 'tool': {
      // Standalone tool frames (plan, todo, search) keep their own card;
      // grouped commands and Agent activity arrive through the branches above.
      return (
        <ToolFrameNode
          frame={frame}
          tasks={tasks}
          interactions={interactions}
          pendingSessionInteractions={pendingSessionInteractions}
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
          onOpenAgent={onOpenAgent}
          onOpenPlanDoc={onOpenPlanDoc}
          plans={plans}
          visible={visible}
        />
      );
    }
    case 'notice':
      return visible ? <NoticeFrame frame={frame} /> : null;
  }
}

function elapsedBetween(startedAt?: string, endedAt?: string): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainingSeconds} 秒`;
}

/** An interaction anchors to a tool frame by `toolCallId` (or its own
 *  interaction id via the frame's `approvalId`). */
function findInteraction(
  toolCallId: string,
  approvalId: string | undefined,
  interactions?: ReadonlyMap<string, TranscriptInteraction>,
): TranscriptInteraction | undefined {
  if (interactions === undefined) return undefined;
  if (approvalId !== undefined) {
    const byId = interactions.get(approvalId);
    if (byId !== undefined) return byId;
  }
  for (const interaction of interactions.values()) {
    if (interaction.toolCallId === toolCallId) return interaction;
  }
  return undefined;
}

/** Project session-level pending interactions onto the child-agent shape the
 *  swarm roster consumes, scoped to the agents this frame spawned. */
function childInteractionsForFrame(
  frame: TranscriptFrame,
  pending: readonly SourcedPendingInteraction[],
): readonly SourcedChildInteraction[] {
  if (frame.kind !== 'tool') return [];
  const agentIds = (frame.agentRefs ?? []).map((ref) => ref.agentId);
  if (agentIds.length === 0) return [];
  const wanted = new Set(agentIds);
  return pending
    .filter(
      (item) => item.interaction.state === 'pending' && wanted.has(item.sourceAgentId),
    )
    .map((item) => ({
      sourceAgentId: item.sourceAgentId,
      interaction: item.interaction,
    }));
}

function renderInteraction(
  interaction: TranscriptInteraction,
  handlers: {
    onResolveApproval?: TurnBlockProps['onResolveApproval'];
    onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
    onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
    onOpenPlanDoc?: OpenPlanDoc;
  },
): ReactNode {
  if (interaction.interactionKind === 'approval' && handlers.onResolveApproval !== undefined) {
    return (
      <ApprovalCard
        interaction={interaction}
        onResolve={(decision, options) => handlers.onResolveApproval!(interaction, decision, options)}
        onOpenPlanDoc={handlers.onOpenPlanDoc}
      />
    );
  }
  if (interaction.interactionKind === 'question' && handlers.onAnswerQuestion !== undefined) {
    return (
      <QuestionCard
        interaction={interaction}
        onAnswer={(response) => handlers.onAnswerQuestion!(interaction, response)}
        onDismiss={() => handlers.onDismissQuestion?.(interaction)}
      />
    );
  }
  return null;
}
