import type {
  TranscriptAttachment,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptStep,
  TranscriptTask,
  TranscriptTurn,
} from '@moonshot-ai/transcript';
import type { ApprovalDecision, QuestionResponse } from '@moonshot-ai/protocol';
import type { ReactNode } from 'react';

import { ApprovalCard, type ApprovalResolveHandler, type ApprovalResolveOptions } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';
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
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: TurnBlockProps) {
  return (
    <div className="mb-4">
      {turn.prompt !== undefined && turn.prompt !== '' ? <TurnPrompt turn={turn} /> : null}
      {turn.attachmentIds !== undefined && turn.attachmentIds.length > 0 ? (
        <AttachmentChips ids={turn.attachmentIds} attachments={attachments} />
      ) : null}
      <TurnContext.Provider
        value={{
          state: turn.state,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          durationMs: turn.durationMs,
        }}
      >
        {turn.steps.map((step) => (
          <StepView
            key={step.stepId}
            step={step}
            tasks={tasks}
            interactions={interactions}
            attachments={attachments}
            onResolveApproval={onResolveApproval}
            onAnswerQuestion={onAnswerQuestion}
            onDismissQuestion={onDismissQuestion}
          />
        ))}
      </TurnContext.Provider>
      {turn.state === 'failed' && turn.error !== undefined ? (
        <div className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--red-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--red-500)_12%,transparent)] px-3 py-2 text-[12px] text-[var(--red-400)]">
          {turn.error}
        </div>
      ) : null}
    </div>
  );
}

function TurnPrompt({ turn }: { turn: TranscriptTurn }) {
  if (turn.origin.kind === 'user') {
    return (
      <div className="mb-2 flex justify-end">
        <div className="max-w-[80%] rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-editor-opaque)] px-3 py-2">
          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-foreground)] opacity-50">
            You
          </div>
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-text-foreground)]">
            {turn.prompt}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mb-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-foreground)] opacity-50">
        {turn.origin.kind}
      </div>
      <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-foreground)] opacity-80">
        {turn.prompt}
      </div>
    </div>
  );
}

function AttachmentChips({
  ids,
  attachments,
}: {
  ids: readonly string[];
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {ids.map((id) => {
        const attachment = attachments?.get(id);
        return (
          <span
            key={id}
            className="rounded border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-foreground)] opacity-70"
            title={attachment?.mediaType}
          >
            📎 {attachment?.name ?? attachment?.mediaType ?? id}
          </span>
        );
      })}
    </div>
  );
}

function StepView({
  step,
  tasks,
  interactions,
  attachments,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  step: TranscriptStep;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
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
          tasks={tasks}
          interactions={interactions}
          attachments={attachments}
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
  tasks,
  interactions,
  attachments,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  frame: TranscriptFrame;
  tasks?: ReadonlyMap<string, TranscriptTask>;
  interactions?: ReadonlyMap<string, TranscriptInteraction>;
  attachments?: ReadonlyMap<string, TranscriptAttachment>;
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
}) {
  switch (frame.kind) {
    case 'text':
      return <TextFrame frame={frame} attachments={attachments} />;
    case 'thinking':
      return <ThinkingFrame frame={frame} />;
    case 'tool': {
      const interaction = findInteraction(frame.toolCallId, frame.approvalId, interactions);
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
          <ToolFrame frame={frame} task={tasks?.get(frame.taskId ?? '')} interaction={interaction} />
          {pending}
        </>
      );
    }
    case 'notice':
      return <NoticeFrame frame={frame} />;
  }
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
