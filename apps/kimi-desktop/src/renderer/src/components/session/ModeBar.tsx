/**
 * ComposerAddMenu — Codex-style "Add" surface for attachments and the
 * session's less-frequent operating modes. Keeping these controls beside the
 * prompt makes their scope clear without turning the title bar into a second
 * navigation system.
 */

import {
  CaretRight,
  Command,
  File,
  Folder,
  Paperclip,
  PuzzlePiece,
  Robot,
  Strategy,
  Target,
} from '@phosphor-icons/react';
import type { SessionAgentConfigPartial } from '@moonshot-ai/protocol';
import { useState, type ReactNode } from 'react';

import { useGoal, useSession, useUpdateSessionProfile } from '#/lib/queries';
import { agentConfigPatch } from '#/lib/sessionModes';

import { GoalStatusCard } from './GoalStatusCard';

export interface ComposerAddMenuProps {
  readonly sessionId: string;
  readonly planMode: boolean;
  readonly onPlanModeChange: (value: boolean) => void;
  readonly goalMode: boolean;
  readonly onGoalModeChange: (value: boolean) => void;
  readonly onFiles: (files: readonly File[]) => void;
  readonly onInsertText: (text: string) => void;
  readonly onClose: () => void;
}

export function ComposerAddMenu({
  sessionId,
  planMode,
  onPlanModeChange,
  goalMode,
  onGoalModeChange,
  onFiles,
  onInsertText,
  onClose,
}: ComposerAddMenuProps) {
  const sessionQuery = useSession(sessionId);
  const goalQuery = useGoal(sessionId);
  const updateProfile = useUpdateSessionProfile(sessionId);
  const [goalCardOpen, setGoalCardOpen] = useState(false);

  const config = sessionQuery.data?.agent_config;
  const goal = goalQuery.data;
  const goalActive = goal !== null && goal !== undefined;
  const swarmOn = config?.swarm_mode === true;
  const pending = updateProfile.isPending;

  const patch = (agentConfig: SessionAgentConfigPartial): void => {
    if (pending) return;
    updateProfile.mutate(agentConfigPatch(agentConfig));
  };

  return (
    <>
      <div className="ui-popover max-h-[23rem] w-full overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] p-1.5 shadow-[var(--shadow-xl)]">
        <MenuLink
          icon={<File size={15} weight="regular" />}
          label="文件"
          onClick={() => {
            onInsertText('@');
            onClose();
          }}
        />
        <MenuLink
          icon={<Folder size={15} weight="regular" />}
          label="文件夹"
          onClick={() => {
            onInsertText('@');
            onClose();
          }}
        />
        <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-[12.5px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]">
          <Paperclip size={15} weight="regular" className="shrink-0 text-[var(--color-text-secondary)]" />
          <span className="min-w-0 flex-1">附件</span>
          <span className="text-[11px] text-[var(--color-text-tertiary)]">本地文件和图片</span>
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              if (files !== null) onFiles(Array.from(files));
              event.target.value = '';
              onClose();
            }}
          />
        </label>
        <MenuLink
          icon={<PuzzlePiece size={15} weight="regular" />}
          label="插件"
          onClick={() => {
            onInsertText('$');
            onClose();
          }}
        />
        <MenuLink
          icon={<Robot size={15} weight="regular" />}
          label="智能体"
          description="面向特定任务的专业智能体"
          active={swarmOn}
          onClick={() => patch({ swarm_mode: !swarmOn })}
        />
        <MenuLink
          icon={<Command size={15} weight="regular" />}
          label="Skills 与 Commands"
          onClick={() => {
            onInsertText('/');
            onClose();
          }}
        />

        <div className="my-1 h-px bg-[var(--color-border-light)]" />
        <MenuToggle
          icon={<Strategy size={15} weight="regular" />}
          label="计划"
          description="先制定方案，确认后再执行"
          active={planMode}
          disabled={pending}
          onClick={() => {
            if (pending) return;
            const nextPlanMode = !planMode;
            onPlanModeChange(nextPlanMode);
            updateProfile.mutate(agentConfigPatch({ plan_mode: nextPlanMode }), {
              onError: () => onPlanModeChange(planMode),
            });
          }}
        />
        <MenuToggle
          icon={<Target size={15} weight="regular" />}
          label="目标"
          description={goalActive ? '查看或管理持续追踪的目标' : '设定目标，持续推进直至完成'}
          active={goalMode}
          disabled={pending}
          onClick={() => {
            if (goalActive) setGoalCardOpen(true);
            else {
              onGoalModeChange(!goalMode);
              onClose();
            }
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

function MenuLink({
  icon,
  label,
  description,
  active = false,
  disabled = false,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--color-list-hover)] disabled:opacity-45"
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-foreground)]">{label}</span>
      {description !== undefined ? (
        <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">{description}</span>
      ) : null}
      {active ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-text-accent)]" /> : null}
      <CaretRight size={12} weight="bold" className="shrink-0 text-[var(--color-text-tertiary)]" />
    </button>
  );
}

function MenuToggle(props: Parameters<typeof MenuLink>[0] & { readonly description: string }) {
  const { icon, label, description, active, disabled = false, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--color-list-hover)] disabled:opacity-45"
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-text-foreground)]">{label}</span>
      <span className="truncate text-[11px] text-[var(--color-text-tertiary)]">{description}</span>
      <span className={`relative h-5 w-8 shrink-0 rounded-full transition-colors ${active ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-background-button-secondary)]'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}
