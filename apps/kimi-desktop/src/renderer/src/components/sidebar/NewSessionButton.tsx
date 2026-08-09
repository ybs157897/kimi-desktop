import { useId } from 'react';
import { PlusCircle } from '@phosphor-icons/react';

export interface NewSessionButtonProps {
  readonly onCreate: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Creation error owned by the shell; the primary button remains the retry action. */
  readonly error?: string | null;
}

/**
 * Sidebar entry point for creating a session at the latest workspace through
 * the shell's `onCreate` callback. Sits above the session search and shares
 * its full width.
 */
export function NewSessionButton({
  onCreate,
  disabled = false,
  busy = false,
  error = null,
}: NewSessionButtonProps) {
  const errorId = useId();
  const visibleError = busy ? null : error;
  const label = busy ? '正在创建…' : visibleError === null ? '新建会话' : '重试新建会话';

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled || busy}
        aria-busy={busy}
        aria-label={label}
        aria-describedby={visibleError === null ? undefined : errorId}
        title={visibleError === null ? label : `新建会话失败：${visibleError}`}
        className="ui-pressable flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-transparent bg-[var(--color-background-button-secondary)] px-2.5 text-left text-[length:var(--client-content-font-size)] font-medium tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:border-[var(--color-border-focus)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <span className="text-[length:var(--client-caption-font-size)]" aria-hidden>
            …
          </span>
        ) : (
          <PlusCircle size={16} weight="regular" aria-hidden />
        )}
        <span>{label}</span>
      </button>
      {visibleError !== null ? (
        <div
          id={errorId}
          role="alert"
          className="mt-1 w-full rounded-[var(--radius-sm)] border border-[var(--color-border-error)] px-2 py-1 text-[length:var(--client-caption-font-size)] leading-[1.3] text-[var(--color-text-danger)]"
        >
          新建会话失败：{visibleError}
        </div>
      ) : null}
    </div>
  );
}
