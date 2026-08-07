/**
 * GoalStatusCard — the active goal's live status: objective, status chip,
 * turns/tokens/elapsed stats, budget progress, and pause/resume/cancel
 * controls. Data comes from `useGoal` (REST baseline + `goal.updated` ws
 * events); the controls write `goal_control` through the session profile.
 */

import type { GoalSnapshot } from '@moonshot-ai/protocol';

import { useUpdateSessionProfile } from '#/lib/queries';
import {
  agentConfigPatch,
  formatDuration,
  formatTokens,
  GOAL_STATUS_LABELS,
  GOAL_STATUS_TONES,
  goalProgress,
} from '#/lib/sessionModes';

export interface GoalStatusCardProps {
  readonly sessionId: string;
  readonly goal: GoalSnapshot;
}

export function GoalStatusCard({ sessionId, goal }: GoalStatusCardProps) {
  const updateProfile = useUpdateSessionProfile(sessionId);
  const progress = goalProgress(goal);
  const pending = updateProfile.isPending;

  const control = (kind: 'pause' | 'resume' | 'cancel'): void => {
    if (pending) return;
    updateProfile.mutate(agentConfigPatch({ goal_control: kind }));
  };

  const buttonClass =
    'rounded-md px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50';

  return (
    <div className="w-72 rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] p-3 shadow-xl">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-[var(--color-text-foreground)]">目标</span>
        <span
          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color: GOAL_STATUS_TONES[goal.status], backgroundColor: 'var(--color-list-hover)' }}
        >
          {GOAL_STATUS_LABELS[goal.status]}
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[12px] leading-5 text-[var(--color-text-foreground)]">
        {goal.objective}
      </p>

      <dl className="mt-2 flex gap-4 text-[11px]">
        <div>
          <dt className="text-[var(--gray-500)]">回合</dt>
          <dd className="mt-0.5 text-[var(--color-text-foreground)]">{goal.turnsUsed}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-500)]">Tokens</dt>
          <dd className="mt-0.5 text-[var(--color-text-foreground)]">{formatTokens(goal.tokensUsed)}</dd>
        </div>
        <div>
          <dt className="text-[var(--gray-500)]">耗时</dt>
          <dd className="mt-0.5 text-[var(--color-text-foreground)]">{formatDuration(goal.wallClockMs)}</dd>
        </div>
      </dl>

      {progress !== undefined ? (
        <div className="mt-2.5">
          {progress.percent !== null ? (
            <div className="h-1 overflow-hidden rounded-full bg-[var(--color-border)]">
              <div className="h-full rounded-full bg-[var(--blue-400)]" style={{ width: `${progress.percent}%` }} />
            </div>
          ) : null}
          <p className="mt-1 text-[10px] text-[var(--gray-500)]">{progress.used}</p>
        </div>
      ) : null}

      {goal.terminalReason !== undefined && goal.terminalReason !== '' ? (
        <p className="mt-1.5 text-[11px] leading-4 text-[var(--gray-500)]">{goal.terminalReason}</p>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5 border-t border-[var(--color-border-light)] pt-2">
        {goal.status === 'active' ? (
          <button type="button" onClick={() => control('pause')} disabled={pending} className={buttonClass}>
            {pending ? '…' : '暂停'}
          </button>
        ) : null}
        {goal.status === 'paused' ? (
          <button type="button" onClick={() => control('resume')} disabled={pending} className={buttonClass}>
            {pending ? '…' : '继续'}
          </button>
        ) : null}
        {goal.status !== 'complete' ? (
          <button type="button" onClick={() => control('cancel')} disabled={pending} className={buttonClass}>
            {pending ? '…' : '取消'}
          </button>
        ) : null}
        {updateProfile.isError ? (
          <span className="ml-auto text-[10px] text-[var(--red-400)]">操作失败</span>
        ) : null}
      </div>
    </div>
  );
}
