import type {
  ToolCallFrame,
  TranscriptFrame,
  TranscriptItem,
  TranscriptTask,
  TranscriptTurn,
  TurnState,
} from '@moonshot-ai/transcript';
import type { ApprovalDecision } from '@moonshot-ai/protocol';

import type { SourcedPendingInteraction } from './sessionInteractions';

/** Timeline items currently exposed by the transcript projection. */
export function visibleTimelineItems(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  return items.filter(
    (item) => item.kind !== 'marker' || item.marker === 'compact',
  );
}

/**
 * Frame id at the tip of a live turn. Text / thinking UIs that key off
 * "still streaming" must compare against this — the turn stays `running`
 * through tool calls, so turn.state alone would leave a blinking cursor (or
 * open thinking body) on already-finished frames.
 */
export function liveTailFrameId(turn: {
  state: TurnState;
  steps: readonly { frames: readonly { frameId: string }[] }[];
}): string | undefined {
  if (turn.state !== 'running' && turn.state !== 'queued') return undefined;
  for (let i = turn.steps.length - 1; i >= 0; i--) {
    const frames = turn.steps[i]!.frames;
    if (frames.length > 0) return frames[frames.length - 1]!.frameId;
  }
  return undefined;
}

/** The assistant text that should remain visible when the rest of a turn is
 * folded into its process disclosure. A settled turn exposes its last
 * non-empty assistant message; a live turn only exposes text while that text
 * is the streaming tail, so commentary disappears again when a tool starts. */
export function resultTextFrameId(
  turn: Pick<TranscriptTurn, 'state' | 'steps'>,
): string | undefined {
  if (turn.state === 'running' || turn.state === 'queued') {
    const tailId = liveTailFrameId(turn);
    if (tailId === undefined) return undefined;
    for (let stepIndex = turn.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
      const frame = turn.steps[stepIndex]!.frames.find((candidate) => candidate.frameId === tailId);
      if (frame?.kind === 'text' && frame.role === 'assistant') return frame.frameId;
    }
    return undefined;
  }

  for (let stepIndex = turn.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const frames = turn.steps[stepIndex]!.frames;
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex]!;
      if (frame.kind === 'text' && frame.role === 'assistant' && frame.text.trim() !== '') {
        return frame.frameId;
      }
    }
  }
  return undefined;
}

/** Pending interactions currently rendered by the conversation surface. */
export function pendingComposerInteractions(
  interactions: readonly SourcedPendingInteraction[],
): readonly SourcedPendingInteraction[] {
  const pending = interactions.filter(({ interaction }) => interaction.state === 'pending');
  const newest = pending.at(-1);
  return newest === undefined ? [] : [newest];
}

/** Task entity linked to a tool frame, including Agent frames that only carry agentRefs. */
export function taskForToolFrame(
  frame: Pick<ToolCallFrame, 'taskId' | 'agentRefs'>,
  tasks: ReadonlyMap<string, TranscriptTask> | undefined,
): TranscriptTask | undefined {
  if (tasks === undefined) return undefined;
  if (frame.taskId !== undefined) {
    const direct = tasks.get(frame.taskId);
    if (direct !== undefined) return direct;
  }
  for (const ref of frame.agentRefs ?? []) {
    const byId = tasks.get(ref.agentId);
    if (byId !== undefined) return byId;
    for (const task of tasks.values()) {
      if (task.agentId === ref.agentId) return task;
    }
  }
  return undefined;
}

/** Pending child interaction linked to an Agent frame through agentRefs. */
export function pendingInteractionForToolFrame(
  frame: Pick<ToolCallFrame, 'agentRefs'>,
  interactions: readonly SourcedPendingInteraction[],
): SourcedPendingInteraction | undefined {
  const agentIds = new Set((frame.agentRefs ?? []).map((ref) => ref.agentId));
  if (agentIds.size === 0) return undefined;
  for (let index = interactions.length - 1; index >= 0; index -= 1) {
    const pending = interactions[index]!;
    if (pending.interaction.state === 'pending' && agentIds.has(pending.sourceAgentId)) {
      return pending;
    }
  }
  return undefined;
}

/** Whether resolving an approval should also terminate the active prompt. */
export function shouldAbortAfterApproval(
  decision: ApprovalDecision,
  selectedLabel?: string,
  sourceAgentId = 'main',
): boolean {
  return (
    sourceAgentId === 'main' &&
    decision === 'rejected' &&
    selectedLabel?.toLowerCase() !== 'revise'
  );
}

/** Whether the live thinking affordance has meaningful content to expose. */
export function hasThinkingContent(text: string): boolean {
  return text.trim() !== '';
}

/** User-facing type label for a single subagent call. Prefer the raw input's
 * explicit type because older producers may only emit a generic display name. */
export function agentCallTypeLabel(
  frame: Pick<ToolCallFrame, 'name' | 'input'>,
  displayName?: string,
): string {
  const input =
    frame.input !== null && typeof frame.input === 'object' && !Array.isArray(frame.input)
      ? (frame.input as Record<string, unknown>)
      : undefined;
  const explicitType = input?.['subagent_type'] ?? input?.['subagent_name'];
  const raw =
    (typeof explicitType === 'string' && explicitType.trim() !== '' ? explicitType : undefined) ??
    (typeof displayName === 'string' && displayName.trim() !== '' ? displayName : undefined) ??
    frame.name;

  if (/^coder[\s_-]*agent$/i.test(raw) || /^coder$/i.test(raw)) return 'Coder Agent';
  if (/^tidal$/i.test(raw)) return 'Tidal';
  return raw;
}
