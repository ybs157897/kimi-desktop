import { useState } from 'react';

import { useFsHome } from '#/lib/queries';

import { FolderPicker } from './FolderPicker';

export interface NewSessionButtonProps {
  readonly onCreate: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  /** Pick a recent workspace root from the dropdown instead of the default
   *  (home) cwd; the shell owns the create + auto-select flow. When absent,
   *  picking a root falls back to `onCreate`. */
  readonly onCreateWithCwd?: ((cwd: string) => void);
}

/** Basename of a POSIX path — the compact label of a recent root. */
function rootLabel(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}

/**
 * New chat entry point of the sidebar: the primary click creates a session at
 * the server host's home (via the shell's `onCreate`); a chevron dropdown
 * lists the server's recent workspace roots (`GET /api/v1/fs:home`) for
 * creating at a specific directory.
 */
export function NewSessionButton({
  onCreate,
  disabled = false,
  busy = false,
  onCreateWithCwd,
}: NewSessionButtonProps) {
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const fsHome = useFsHome();
  const recentRoots = fsHome.data?.recent_roots ?? [];

  const createAt = (cwd: string) => {
    setOpen(false);
    if (onCreateWithCwd !== undefined) onCreateWithCwd(cwd);
    else onCreate();
  };

  return (
    <div
      className="relative flex items-stretch gap-0.5"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled || busy}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? <span className="text-[12px]">…</span> : <span aria-hidden>＋</span>}
        新建会话
      </button>
      <button
        type="button"
        aria-label="从最近目录新建会话"
        title="从最近目录新建会话"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled || busy}
        className="flex w-8 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          aria-hidden
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M2 3.5l3 3 3-3" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] py-1 shadow-xl">
            <div className="px-3 py-1 text-[10px] font-semibold tracking-wider text-[var(--gray-500)] uppercase">
              最近目录
            </div>
            {fsHome.isLoading ? (
              <div className="px-3 py-1.5 text-[12px] text-[var(--gray-500)]">加载中…</div>
            ) : recentRoots.length === 0 ? (
              <div className="px-3 py-1.5 text-[12px] text-[var(--gray-500)]">暂无最近目录</div>
            ) : (
              recentRoots.map((root) => (
                <button
                  key={root}
                  type="button"
                  onClick={() => createAt(root)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--color-list-hover)]"
                >
                  <div className="truncate text-[12px] font-medium text-[var(--color-text-foreground)]">
                    {rootLabel(root)}
                  </div>
                  <div className="truncate font-mono text-[10px] text-[var(--gray-500)]">{root}</div>
                </button>
              ))
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setBrowsing(true);
              }}
              className="mt-1 block w-full border-t border-[var(--color-border-light)] px-3 py-1.5 text-left text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              浏览其它目录…
            </button>
          </div>
        </>
      ) : null}
      {browsing ? (
        <FolderPicker
          onPick={(cwd) => {
            setBrowsing(false);
            if (onCreateWithCwd !== undefined) onCreateWithCwd(cwd);
            else onCreate();
          }}
          onClose={() => setBrowsing(false)}
        />
      ) : null}
    </div>
  );
}
