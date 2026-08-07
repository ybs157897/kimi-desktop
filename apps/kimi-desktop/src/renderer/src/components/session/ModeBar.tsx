/**
 * ModeBar — the session's mode cluster in the header (M6): permission-mode
 * select, plan / swarm toggles, and the goal entry + live status card.
 *
 * All writes go through `POST .../profile` (`agent_config`) — the only v2
 * write path for these fields; the prompt-body plan/swarm/goal fields are
 * v1-compat and ignored. Engine-side changes (the model entering plan/swarm
 * on its own) merge into the cached session record via `agent.status.updated`
 * and `goal.updated` on the app-level activity socket.
 */

import { useState } from 'react';
import type { PromptPermissionMode, SessionAgentConfigPartial } from '@moonshot-ai/protocol';

import { useGoal, useSession, useUpdateSessionProfile } from '#/lib/queries';
import { agentConfigPatch } from '#/lib/sessionModes';

import { GoalDialog } from './GoalDialog';
import { GoalStatusCard } from './GoalStatusCard';

export interface ModeBarProps {
  readonly sessionId: string | null;
}

/** Compact header labels; the titles carry the full descriptions. */
const PERMISSION_OPTIONS: readonly { value: PromptPermissionMode; label: string; title: string }[] = [
  { value: 'manual', label: 'Ask', title: '每次工具调用前询问' },
  { value: 'auto', label: 'Auto', title: '按会话内规则自动批准' },
  { value: 'yolo', label: 'YOLO', title: '不询问，直接执行' },
];

export function ModeBar({ sessionId }: ModeBarProps) {
  const sessionQuery = useSession(sessionId);
  const goalQuery = useGoal(sessionId);
  const updateProfile = useUpdateSessionProfile(sessionId ?? '');
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [goalCardOpen, setGoalCardOpen] = useState(false);

  const session = sessionQuery.data;
  const goal = goalQuery.data;
  const goalActive = goal !== null && goal !== undefined;

  if (sessionId === null) return null;

  const config = session?.agent_config;
  const planOn = config?.plan_mode === true;
  const swarmOn = config?.swarm_mode === true;
  const permission = config?.permission_mode ?? '';
  const pending = updateProfile.isPending;

  const patch = (agentConfig: SessionAgentConfigPartial): void => {
    if (pending) return;
    updateProfile.mutate(agentConfigPatch(agentConfig));
  };

  const chipClass = (on: boolean): string =>
    `rounded-lg px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-60 ${
      on
        ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
    }`;

  return (
    <div className="app-no-drag ml-auto flex items-center gap-1">
      <select
        value={permission}
        disabled={pending}
        aria-label="权限模式"
        title="Permission mode"
        onChange={(event) => {
          const next = event.target.value as PromptPermissionMode | '';
          if (next !== '') patch({ permission_mode: next });
        }}
        className="h-7 rounded-lg border border-transparent bg-transparent px-1.5 text-[11.5px] font-medium text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-list-hover)] focus:border-[var(--color-border-heavy)] disabled:opacity-60"
      >
        <option value="">默认</option>
        {PERMISSION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} title={option.title}>
            {option.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => patch({ plan_mode: !planOn })}
        disabled={pending}
        title="计划模式：限制为只读与计划文件编辑"
        className={chipClass(planOn)}
      >
        计划
      </button>

      <button
        type="button"
        onClick={() => patch({ swarm_mode: !swarmOn })}
        disabled={pending}
        title="Swarm 模式：任务可并行分发给多个子代理"
        className={chipClass(swarmOn)}
      >
        Swarm
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (goalActive) setGoalCardOpen((open) => !open);
            else setGoalDialogOpen(true);
          }}
          disabled={pending}
          title={goalActive ? '目标状态' : '设定目标'}
          className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-60 ${
            goalCardOpen || goalActive
              ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]'
          }`}
        >
          {goalActive ? (
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-success)]" aria-hidden />
          ) : null}
          Goal
        </button>
        {goalCardOpen && goalActive ? (
          <>
            <div className="fixed inset-0 z-30" onMouseDown={() => setGoalCardOpen(false)} />
            <div className="absolute right-0 top-full z-40 mt-1.5">
              <GoalStatusCard sessionId={sessionId} goal={goal} />
            </div>
          </>
        ) : null}
      </div>

      {goalDialogOpen ? <GoalDialog sessionId={sessionId} onClose={() => setGoalDialogOpen(false)} /> : null}
    </div>
  );
}
