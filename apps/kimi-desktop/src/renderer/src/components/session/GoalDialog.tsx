/**
 * GoalDialog — enter a goal objective for the session. The objective rides
 * `agent_config.goal_objective` through `POST .../profile` (the v2 engine
 * creates the goal from it; the prompt-body `goal_objective` field is
 * v1-compat and ignored). Modal skeleton mirrors FolderPicker: overlay + Esc
 * + backdrop click + three-part layout.
 */

import { useEffect, useRef, useState } from 'react';

import { useUpdateSessionProfile } from '#/lib/queries';
import { agentConfigPatch } from '#/lib/sessionModes';

export interface GoalDialogProps {
  readonly sessionId: string;
  readonly onClose: () => void;
}

export function GoalDialog({ sessionId, onClose }: GoalDialogProps) {
  const [objective, setObjective] = useState('');
  const updateProfile = useUpdateSessionProfile(sessionId);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the input once mounted so typing works immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc closes the dialog (the backdrop handles outside clicks separately).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const trimmed = objective.trim();
  const canSubmit = trimmed !== '' && !updateProfile.isPending;

  const submit = (): void => {
    if (!canSubmit) return;
    updateProfile.mutate(agentConfigPatch({ goal_objective: trimmed }), {
      onSuccess: () => onClose(),
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="设定目标"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[520px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">设定目标</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ✕
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
            className="min-h-[96px] w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2.5 py-2 text-[12px] leading-5 text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)]"
          />
          <p className="mt-1.5 text-[11px] leading-4 text-[var(--gray-500)]">
            目标会在后台持续追踪（回合 / tokens / 时间预算），可随时暂停或取消。
          </p>
          {updateProfile.isError ? (
            <p className="mt-1.5 text-[11px] text-[var(--red-400)]">设定失败，请重试</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-light)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:opacity-40"
          >
            {updateProfile.isPending ? '设定中…' : '开始'}
          </button>
        </div>
      </div>
    </div>
  );
}
