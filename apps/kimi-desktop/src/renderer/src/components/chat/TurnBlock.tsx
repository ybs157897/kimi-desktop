import type {
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';
import type { QuestionResponse } from '@moonshot-ai/protocol';
import type { ReactNode } from 'react';

import type { SourcedPendingInteraction } from '#/lib/sessionInteractions';
import {
  liveTailFrameId,
  pendingInteractionForToolFrame,
  taskForToolFrame,
} from '#/lib/timelinePresentation';

import { ApprovalCard, type ApprovalResolveHandler } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';
import { AttachmentThumbnails } from './attachments/AttachmentThumbnails';
import { TurnContext } from './frameContext';
import { NoticeFrame } from './frames/NoticeFrame';
import { TextFrame } from './frames/TextFrame';
import { ThinkingFrame } from './frames/ThinkingFrame';
import { ToolFrame } from './frames/ToolFrame';

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
}: TurnBlockProps) {
  return (
    <section className="mb-4 last:mb-1">
      {turn.prompt !== undefined && turn.prompt !== '' ? <TurnPrompt turn={turn} /> : null}
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
        {turn.steps.map((step) => (
          <StepView
            key={step.stepId}
            step={step}
            tasks={tasks}
            interactions={interactions}
            attachments={attachments}
            pendingSessionInteractions={pendingSessionInteractions}
            onResolveApproval={onResolveApproval}
            onAnswerQuestion={onAnswerQuestion}
            onDismissQuestion={onDismissQuestion}
          />
        ))}
      </TurnContext.Provider>
      {turn.state === 'failed' && turn.error !== undefined ? (
        <div className="ui-card-enter mb-2 rounded-lg border border-[color-mix(in_srgb,var(--red-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--red-500)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--red-400)]">
          {turn.error}
        </div>
      ) : null}
    </section>
  );
}

function TurnPrompt({ turn }: { turn: TranscriptTurn }) {
  if (turn.origin.kind === 'user') {
    return (
      <div className="ui-card-enter mb-3 flex justify-end">
        <div className="max-w-[min(80%,36rem)] rounded-2xl bg-[var(--color-user-bubble)] px-3.5 py-2.5 shadow-[var(--shadow-sm)]">
          <div className="whitespace-pre-wrap text-[14px] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
            {turn.prompt}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ui-card-enter mb-3 max-w-[46rem] rounded-2xl border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3.5 py-2.5">
      <div className="ui-label mb-1">{turn.origin.kind}</div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-[var(--leading-chat)] text-[var(--color-text-secondary)]">
        {turn.prompt}
      </div>
    </div>
  );
}

function StepView({
  step,
  tasks,
  interactions,
  attachments,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  step: TranscriptStep;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
}) {
  return (
    <div>
      {step.frames.map((frame) => (
        <FrameView
          key={frame.frameId}
          frame={frame}
          stepDurationMs={elapsedBetween(step.startedAt, step.endedAt)}
          tasks={tasks}
          interactions={interactions}
          attachments={attachments}
          pendingSessionInteractions={pendingSessionInteractions}
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
        />
      ))}
      {step.state === 'interrupted' ? (
        <div className="mb-2 px-0.5 text-[10px] italic text-[var(--color-text-foreground)] opacity-50">
          步骤已中断
        </div>
      ) : null}
    </div>
  );
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
}) {
  switch (frame.kind) {
    case 'text':
      return <TextFrame frame={frame} attachments={attachments} />;
    case 'thinking':
      return <ThinkingFrame frame={frame} durationMs={stepDurationMs} />;
    case 'tool': {
      const interaction =
        findInteraction(frame.toolCallId, frame.approvalId, interactions) ??
        pendingInteractionForToolFrame(frame, pendingSessionInteractions)?.interaction;
      const task = taskForToolFrame(frame, tasks);
      const pending =
        interaction !== undefined && interaction.state === 'pending'
          ? renderInteraction(interaction, {
              onResolveApproval,
              onAnswerQuestion,
              onDismissQuestion,
            })
          : null;
      return (
        <>
          <ToolFrame frame={frame} task={task} interaction={interaction} />
          {pending}
        </>
      );
    }
    case 'notice':
      return <NoticeFrame frame={frame} />;
  }
}

function elapsedBetween(startedAt?: string, endedAt?: string): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
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

function renderInteraction(
  interaction: TranscriptInteraction,
  handlers: {
    onResolveApproval?: TurnBlockProps['onResolveApproval'];
    onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
    onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  },
): ReactNode {
  if (interaction.interactionKind === 'approval' && handlers.onResolveApproval !== undefined) {
    return (
      <ApprovalCard
        interaction={interaction}
        onResolve={(decision, options) => handlers.onResolveApproval!(interaction, decision, options)}
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
