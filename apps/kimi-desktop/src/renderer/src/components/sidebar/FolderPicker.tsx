/**
 * FolderPicker — a session-free directory browser backed by `GET /api/v1/fs:browse`
 * (one level of subdirectories, no recursion). Used by `NewSessionButton` to pick
 * a workspace `cwd` outside the recent-roots list.
 *
 * The popover walks directories by path: it starts at the host home (the empty
 * query), shows the parent (when not at the root) and the current level's
 * subdirectories, and resolves with the highlighted directory on "Choose".
 */

import { useEffect, useRef, useState } from 'react';

import { useFsBrowse } from '#/lib/queries';

export interface FolderPickerProps {
  /** Resolve with the chosen absolute directory; the owner creates the session. */
  readonly onPick: (cwd: string) => void;
  readonly onClose: () => void;
}

/** Basename of a POSIX path — the compact label; `/` stays as `/`. */
function basename(path: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? '/';
}

export function FolderPicker({ onPick, onClose }: FolderPickerProps) {
  // `undefined` resolves the server host home; navigation replaces it.
  const [path, setPath] = useState<string | undefined>(undefined);
  const browse = useFsBrowse(path);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the list once mounted so keyboard nav works immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc closes the picker (the backdrop handles outside clicks separately).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const current = browse.data;
  const parent: string | undefined = current?.parent ?? undefined;
  const listing = current?.entries ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="选择工作区目录"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[560px] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[12px] font-medium text-[var(--color-text-foreground)]">选择工作区目录</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--gray-500)]" title={current?.path}>
            {current?.path ?? '加载中…'}
          </span>
          {parent !== undefined ? (
            <button
              type="button"
              onClick={() => setPath(parent)}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              ‹ 上级
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {browse.isLoading ? (
            <div className="px-4 py-3 text-[12px] text-[var(--gray-500)]">加载中…</div>
          ) : browse.isError ? (
            <div className="px-4 py-3 text-[12px] text-[var(--red-400)]">
              无法读取目录{browse.error instanceof Error ? `：${browse.error.message}` : ''}
            </div>
          ) : listing.length === 0 ? (
            <div className="px-4 py-3 text-[12px] text-[var(--gray-500)]">没有子目录</div>
          ) : (
            <ul>
              {listing.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => setPath(entry.path)}
                    onDoubleClick={() => onPick(entry.path)}
                    className="flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-[var(--color-list-hover)]"
                  >
                    <span aria-hidden className="shrink-0 text-[var(--gray-500)]">
                      📁
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
                      {entry.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--color-border-light)] px-4 py-2.5">
          <input
            ref={inputRef}
            type="text"
            value={path ?? ''}
            placeholder={current?.path ?? ''}
            onChange={(event) => setPath(event.target.value === '' ? undefined : event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)]"
          />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={current?.path === undefined}
            onClick={() => {
              if (current?.path !== undefined) onPick(current.path);
            }}
            className="rounded-md bg-[var(--gray-1000)] px-3 py-1 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--gray-900)] disabled:opacity-40"
          >
            选择「{current ? basename(current.path) : ''}」
          </button>
        </div>
      </div>
    </div>
  );
}
