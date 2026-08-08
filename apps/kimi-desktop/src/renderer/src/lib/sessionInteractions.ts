import type { ApprovalRequest, QuestionRequest } from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';

/** A session-scoped pending interaction plus the agent that is blocked by it. */
export interface SourcedPendingInteraction {
  readonly sourceAgentId: string;
  readonly createdAt?: string;
  readonly interaction: TranscriptInteraction;
}

/**
 * Project the two session-level pending REST collections onto the transcript
 * interaction shape consumed by the existing cards. The source agent stays
 * beside the interaction: it is routing metadata, not part of the transcript
 * entity or the resolve contract.
 */
export function projectPendingSessionInteractions(
  approvals: readonly ApprovalRequest[],
  questions: readonly QuestionRequest[],
): readonly SourcedPendingInteraction[] {
  const projected: SourcedPendingInteraction[] = [
    ...approvals.map((request) => ({
      sourceAgentId: request.agent_id ?? 'main',
      createdAt: request.created_at,
      interaction: {
        interactionId: request.approval_id,
        interactionKind: 'approval' as const,
        toolCallId: request.tool_call_id,
        state: 'pending' as const,
        request,
      },
    })),
    ...questions.map((request) => ({
      sourceAgentId: request.agent_id ?? 'main',
      createdAt: request.created_at,
      interaction: {
        interactionId: request.question_id,
        interactionKind: 'question' as const,
        toolCallId: request.tool_call_id,
        state: 'pending' as const,
        request,
      },
    })),
  ];
  projected.sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
  return projected;
}

/** Compatibility fallback while the first session-level REST query loads. */
export function projectAgentPendingInteractions(
  interactions: ReadonlyMap<string, TranscriptInteraction>,
  sourceAgentId: string,
): readonly SourcedPendingInteraction[] {
  const projected: SourcedPendingInteraction[] = [];
  for (const interaction of interactions.values()) {
    if (interaction.state === 'pending') {
      projected.push({ sourceAgentId, createdAt: undefined, interaction });
    }
  }
  return projected;
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
