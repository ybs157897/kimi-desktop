/**
 * GoalDialog — enter a goal objective for the session. The objective rides
 * `agent_config.goal_objective` through `POST .../profile` (the v2 engine
 * creates the goal from it; the prompt-body `goal_objective` field is
 * v1-compat and ignored). Modal skeleton mirrors FolderPicker: overlay + Esc
 * + backdrop click + three-part layout.
 */

import { X } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import { useUpdateSessionProfile } from '#/lib/queries';
import { agentConfigPatch } from '#/lib/sessionModes';
import { useModalDialog } from '#/lib/useModalDialog';

export interface GoalDialogProps {
  readonly sessionId: string;
  readonly onClose: () => void;
}

export function GoalDialog({ sessionId, onClose }: GoalDialogProps) {
  const [objective, setObjective] = useState('');
  const updateProfile = useUpdateSessionProfile(sessionId);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose, { initialFocusRef: inputRef });

  const trimmed = objective.trim();
  const canSubmit = trimmed !== '' && !updateProfile.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    updateProfile.mutate(agentConfigPatch({ goal_objective: trimmed }), {
      onSuccess: () => onClose(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-terminal-shell)_40%,transparent)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="设定目标"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[520px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-[var(--shadow-floating-panel)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">设定目标</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        <div className="px-4 py-3">
          <textarea
            ref={inputRef}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
            }}
            placeholder="描述你要达成的目标，例如：修复所有测试失败…"
            className="min-h-[96px] w-full resize-y rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2.5 py-2 text-[12px] leading-5 text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
          />
          <p className="mt-1.5 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
            目标会在后台持续追踪（回合 / tokens / 时间预算），可随时暂停或取消。
          </p>
          {updateProfile.isError ? (
            <p className="mt-1.5 text-[11px] text-[var(--color-text-danger)]">设定失败，请重试</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-light)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-sm)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1 text-[12px] font-medium text-[var(--color-button-primary-foreground)] disabled:opacity-40"
          >
            {updateProfile.isPending ? '设定中…' : '开始'}
          </button>
        </div>
      </div>
    </div>
  );
}
