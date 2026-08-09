/** ComposerAddMenu — the prompt-scoped plan / goal / swarm controls. */

import { Strategy, Target, UsersThree } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

import { useGoal } from '#/lib/queries';

import { GoalStatusCard } from './GoalStatusCard';

export interface ComposerAddMenuProps {
  readonly sessionId: string;
  readonly planMode: boolean;
  readonly onPlanModeChange: (value: boolean) => void;
  readonly goalMode: boolean;
  readonly onGoalModeChange: (value: boolean) => void;
  readonly swarmMode: boolean;
  readonly onSwarmModeChange: (value: boolean) => void;
  readonly disabled?: boolean;
  readonly onClose: () => void;
}

export function ComposerAddMenu({
  sessionId,
  planMode,
  onPlanModeChange,
  goalMode,
  onGoalModeChange,
  swarmMode,
  onSwarmModeChange,
  disabled = false,
  onClose,
}: ComposerAddMenuProps) {
  const goalQuery = useGoal(sessionId);
  const [goalCardOpen, setGoalCardOpen] = useState(false);

  const goal = goalQuery.data;
  const goalActive = goal !== null && goal !== undefined;

  return (
    <>
      <div className="ui-popover w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] p-1.5 shadow-[var(--shadow-xl)]">
        <MenuToggle
          icon={<Strategy size={16} weight="regular" />}
          label="计划"
          active={planMode}
          disabled={disabled}
          onClick={() => {
            onPlanModeChange(!planMode);
            onClose();
          }}
        />
        <MenuToggle
          icon={<Target size={16} weight="regular" />}
          label="目标"
          active={goalMode}
          disabled={disabled}
          onClick={() => {
            if (goalActive) setGoalCardOpen(true);
            else {
              onGoalModeChange(!goalMode);
              onClose();
            }
          }}
        />
        <MenuToggle
          icon={<UsersThree size={16} weight="regular" />}
          label="蜂群"
          active={swarmMode}
          disabled={disabled}
          onClick={() => {
            onSwarmModeChange(!swarmMode);
            onClose();
          }}
        />
      </div>

      {goalCardOpen && goalActive ? (
        <div className="absolute bottom-0 left-[calc(100%+8px)] z-50">
          <GoalStatusCard sessionId={sessionId} goal={goal} />
        </div>
      ) : null}
    </>
  );
}

function MenuToggle({
  icon,
  label,
  active,
  disabled = false,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-8 w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left hover:bg-[var(--color-list-hover)] disabled:opacity-45 ${active ? 'bg-[var(--color-list-active)]' : ''}`}
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">{label}</span>
      <span className={`relative h-5 w-8 shrink-0 rounded-[var(--radius-full)] transition-colors ${active ? 'bg-[var(--primary)]' : 'bg-[var(--color-background-button-secondary)]'}`} aria-hidden>
        <span className={`absolute top-0.5 h-4 w-4 rounded-[var(--radius-full)] bg-[var(--primary-foreground)] shadow-[var(--shadow-sm)] transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}
