import { approvalRequestSchema } from '@moonshot-ai/protocol';
import type { TranscriptInteraction } from '@moonshot-ai/transcript';

export interface ApprovalInteractionPresentation {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: unknown;
}

/**
 * Transcript v2 keeps the engine's camelCase approval payload, while the REST
 * list endpoint projects the same request into the protocol's snake_case
 * shape. Normalize both here so rendering and resolution never depend on
 * which transport produced the interaction.
 */
export function approvalInteractionPresentation(
  interaction: Pick<TranscriptInteraction, 'interactionId' | 'toolCallId' | 'request'>,
): ApprovalInteractionPresentation {
  const wire = approvalRequestSchema.safeParse(interaction.request);
  if (wire.success) {
    return {
      approvalId: wire.data.approval_id,
      toolCallId: wire.data.tool_call_id,
      toolName: wire.data.tool_name,
      action: wire.data.action,
      display: wire.data.tool_input_display,
    };
  }

  const raw = asRecord(interaction.request);
  return {
    approvalId: interaction.interactionId,
    toolCallId: stringField(raw, 'toolCallId', 'tool_call_id') ?? interaction.toolCallId ?? interaction.interactionId,
    toolName: stringField(raw, 'toolName', 'tool_name') ?? 'Tool',
    action: stringField(raw, 'action') ?? '请求批准操作',
    display: raw?.['display'] ?? raw?.['tool_input_display'],
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const field = value?.[key];
    if (typeof field === 'string' && field !== '') return field;
  }
  return undefined;
}
