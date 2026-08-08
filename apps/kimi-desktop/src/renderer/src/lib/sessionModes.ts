/**
 * Pure helpers for the session mode system (M6) — the header mode bar
 * (permission / plan / swarm / goal), the goal status card, and the ws-event
 * → react-query cache merge. All functions are side-effect free so the
 * component layer stays thin and vitest can cover them in a node environment.
 */

import type {
  AgentStatusUpdatedEvent,
  GoalSnapshot,
  GoalStatus,
  Session,
  SessionAgentConfigPartial,
  SessionStatusResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

/** Wrap a partial agent-config patch in the profile write body. */
export function agentConfigPatch(agentConfig: SessionAgentConfigPartial): UpdateSessionProfileRequest {
  return { agent_config: agentConfig };
}

/** A newly armed goal uses the next user message as its objective. */
export function goalObjectiveForSubmission(
  goalModeArmed: boolean,
  goalAlreadyActive: boolean,
  message: string,
): string | undefined {
  if (!goalModeArmed || goalAlreadyActive) return undefined;
  const objective = message.trim();
  return objective === '' ? undefined : objective;
}

/**
 * Merge an `agent.status.updated` event into a cached `Session` record so the
 * mode bar tracks engine-side changes (the model entering plan/swarm on its
 * own, a permission flip, a model change) without a REST round-trip. Only the
 * mode-bearing fields are merged; everything else keeps the cached value.
 */
export function applyStatusEventToSession(
  session: Session,
  event: AgentStatusUpdatedEvent,
): Session {
  const agentConfig = { ...session.agent_config };
  if (event.permission !== undefined) agentConfig.permission_mode = event.permission;
  if (event.planMode !== undefined) agentConfig.plan_mode = event.planMode;
  if (event.swarmMode !== undefined) agentConfig.swarm_mode = event.swarmMode;
  if (event.model !== undefined && event.model !== '') agentConfig.model = event.model;
  return { ...session, agent_config: agentConfig };
}

/**
 * Merge an `agent.status.updated` event into a cached session-status record
 * (the status-bar's live context/thinking view). A `maxContextTokens` of 0 is
 * the wire's "unknown" marker, so a zero never overwrites a known limit.
 */
export function applyStatusEventToStatus(
  status: SessionStatusResponse,
  event: AgentStatusUpdatedEvent,
): SessionStatusResponse {
  const next = { ...status };
  if (event.model !== undefined) next.model = event.model;
  if (event.thinkingEffort !== undefined) next.thinking_level = event.thinkingEffort;
  if (event.permission !== undefined) next.permission = event.permission;
  if (event.planMode !== undefined) next.plan_mode = event.planMode;
  if (event.swarmMode !== undefined) next.swarm_mode = event.swarmMode;
  if (event.contextTokens !== undefined) next.context_tokens = event.contextTokens;
  if (event.maxContextTokens !== undefined && event.maxContextTokens > 0) {
    next.max_context_tokens = event.maxContextTokens;
  }
  if (event.contextUsage !== undefined) next.context_usage = event.contextUsage;
  return next;
}

/** Compact human duration — `45s` / `4m` / `4m 12s` / `1h 5m`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Compact token count — `980` / `12.3k` / `1.5M`. */
export function formatTokens(count: number): string {
  const value = Math.max(0, count);
  if (value >= 1_000_000) return `${trimFraction(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimFraction(value / 1_000)}k`;
  return String(value);
}

function trimFraction(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
};

/** Semantic color token per goal status, for the status chip. */
export const GOAL_STATUS_TONES: Record<GoalStatus, string> = {
  active: 'var(--color-text-success)',
  paused: 'var(--color-text-warning)',
  blocked: 'var(--color-text-danger)',
  complete: 'var(--color-text-accent)',
};

/**
 * Budget progress from the goal snapshot — the first declared budget
 * dimension (turns / tokens / wall clock) wins, matching the engine's own
 * precedence. `undefined` when the goal declares no budget.
 */
export interface GoalProgress {
  /** 0..100 (clamped); `null` when the budget is zero/absent. */
  readonly percent: number | null;
  /** e.g. `3 / 20 回合` */
  readonly used: string;
}

export function goalProgress(snapshot: GoalSnapshot): GoalProgress | undefined {
  const { budget } = snapshot;
  if (budget.turnBudget !== null) {
    return {
      percent: budget.turnBudget <= 0 ? null : clampPercent(snapshot.turnsUsed / budget.turnBudget),
      used: `${snapshot.turnsUsed} / ${budget.turnBudget} 回合`,
    };
  }
  if (budget.tokenBudget !== null) {
    return {
      percent: budget.tokenBudget <= 0 ? null : clampPercent(snapshot.tokensUsed / budget.tokenBudget),
      used: `${formatTokens(snapshot.tokensUsed)} / ${formatTokens(budget.tokenBudget)} tokens`,
    };
  }
  if (budget.wallClockBudgetMs !== null) {
    return {
      percent:
        budget.wallClockBudgetMs <= 0 ? null : clampPercent(snapshot.wallClockMs / budget.wallClockBudgetMs),
      used: `${formatDuration(snapshot.wallClockMs)} / ${formatDuration(budget.wallClockBudgetMs)}`,
    };
  }
  return undefined;
}

function clampPercent(ratio: number): number {
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}
