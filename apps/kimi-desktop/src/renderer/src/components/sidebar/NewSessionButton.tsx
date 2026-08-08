import { useId } from 'react';

export interface NewSessionButtonProps {
  readonly onCreate: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Creation error owned by the shell; the primary button remains the retry action. */
  readonly error?: string | null;
}

/**
 * New chat entry point of the sidebar: the primary click creates a session at
 * the latest workspace through the shell's `onCreate` callback.
 */
export function NewSessionButton({
  onCreate,
  disabled = false,
  busy = false,
  error = null,
}: NewSessionButtonProps) {
  const errorId = useId();
  const visibleError = busy ? null : error;

  return (
    <div className="relative">
        <button
          type="button"
          onClick={onCreate}
          disabled={disabled || busy}
          aria-busy={busy}
          aria-describedby={visibleError === null ? undefined : errorId}
          className="ui-pressable flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-2.5 text-left text-[13px] font-semibold tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] shadow-[var(--shadow-sm)] hover:border-[var(--color-border-heavy)] hover:shadow-[var(--shadow-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <span className="text-[12px]" aria-hidden>…</span> : <span aria-hidden>＋</span>}
          {busy ? '正在创建…' : visibleError === null ? '新建会话' : '重试新建会话'}
        </button>
      {visibleError !== null ? (
        <div
          id={errorId}
          role="alert"
          className="mt-1 rounded-md border border-[var(--color-border-error)] px-2 py-1 text-[11px] text-[var(--color-text-danger)]"
        >
          新建会话失败：{visibleError}
        </div>
      ) : null}
    </div>
  );
}
