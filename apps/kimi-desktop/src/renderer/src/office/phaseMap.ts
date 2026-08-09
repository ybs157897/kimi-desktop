import type { AgentPhase } from '@moonshot-ai/protocol';
import type { AgentState } from '#/office/vendored/types/agent';

/**
 * Translate a kimi-desktop `AgentPhase` (the discriminated union the server
 * pushes via `agent.status.updated`) into the office scene's coarse
 * `AgentState`, plus a short human-readable task label for the overlay.
 *
 * The vendored scene only models five states; several agent phases collapse
 * onto the same visual so the overlay text carries the nuance instead.
 */

export interface MappedPhase {
  state: AgentState;
  /** Short label for the overlay/status tag (empty when nothing notable). */
  task: string;
}

/** Whether an agent still belongs in the live office roster. */
export function isLiveAgentPhase(phase: AgentPhase | undefined): boolean {
  if (phase === undefined) return false;
  return (
    phase.kind !== 'idle' &&
    phase.kind !== 'interrupted' &&
    phase.kind !== 'ended'
  );
}

/**
 * Map an agent phase to an office state + task label.
 *
 * Notes on the mapping:
 * - `idle` / `ended` → an idle visual used while the live roster removes the
 *   agent from the scene.
 * - `running` / `tool_call` → actively working; for `tool_call` we surface the
 *   tool name so the overlay shows e.g. "running Edit".
 * - `streaming` → split by stream kind: `thinking` shows the thought bubble,
 *   `assistant`/`tool_call` read as plain working.
 * - `retrying` → still working, annotated with the attempt count.
 * - `awaiting_approval` → paused, shown as thinking with a "待审批" tag.
 * - `interrupted` → idle with the interrupt reason.
 */
export function mapAgentPhase(phase: AgentPhase | undefined): MappedPhase {
  if (phase === undefined) return { state: 'idle', task: '' };
  switch (phase.kind) {
    case 'idle':
      return { state: 'idle', task: '' };
    case 'running':
      return { state: 'working', task: '' };
    case 'tool_call':
      return {
        state: 'working',
        task: phase.name ? `调用 ${phase.name}` : '调用工具',
      };
    case 'streaming':
      if (phase.stream === 'thinking')
        return { state: 'thinking', task: '思考中' };
      if (phase.stream === 'tool_call' && phase.toolName !== undefined) {
        return { state: 'working', task: `调用 ${phase.toolName}` };
      }
      return { state: 'working', task: '生成回复' };
    case 'retrying':
      return {
        state: 'working',
        task: `重试 ${phase.nextAttempt}/${phase.maxAttempts}`,
      };
    case 'awaiting_approval':
      return { state: 'thinking', task: '待审批' };
    case 'interrupted':
      return {
        state: 'idle',
        task: phase.reason === 'aborted' ? '已中断' : phase.reason,
      };
    case 'ended':
      return {
        state: 'idle',
        task: phase.reason === 'completed' ? '已完成' : phase.reason,
      };
  }
}
