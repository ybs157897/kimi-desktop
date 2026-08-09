/**
 * FolderPicker — a session-free directory browser backed by `GET /api/v1/fs:browse`
 * (one level of subdirectories, no recursion). Used by `NewSessionButton` to pick
 * a workspace `cwd` outside the recent-roots list.
 *
 * The popover walks directories by path: it starts at the host home (the empty
 * query), shows the parent (when not at the root) and the current level's
 * subdirectories, and resolves with the highlighted directory on "Choose".
 */

import { ArrowLeft, Folder } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';

import { useFsBrowse } from '#/lib/queries';
import { useModalDialog } from '#/lib/useModalDialog';

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
  const [pathInput, setPathInput] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const browse = useFsBrowse(path);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  useModalDialog(dialogRef, onClose);

  const current = browse.data;
  const parent: string | undefined = current?.parent ?? undefined;
  const listing = current?.entries ?? [];

  useEffect(() => {
    if (current?.path !== undefined) setPathInput(current.path);
  }, [current?.path]);

  useEffect(() => {
    setActiveIndex(0);
  }, [current?.path]);

  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

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
        aria-label="选择工作区目录"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[560px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-[var(--shadow-floating-panel)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
          <span className="text-[length:var(--client-meta-font-size)] font-medium text-[var(--color-text-foreground)]">选择工作区目录</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--code-font-size)] text-[var(--color-text-tertiary)]" title={current?.path}>
            {current?.path ?? '加载中…'}
          </span>
          {parent !== undefined ? (
            <button
              type="button"
              onClick={() => setPath(parent)}
              className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              <ArrowLeft size={12} weight="bold" aria-hidden />
              上级
            </button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {browse.isLoading ? (
            <div className="px-4 py-3 text-[length:var(--client-meta-font-size)] text-[var(--color-text-tertiary)]">加载中…</div>
          ) : browse.isError ? (
            <div className="px-4 py-3 text-[length:var(--client-meta-font-size)] text-[var(--color-text-danger)]">
              无法读取目录{browse.error instanceof Error ? `：${browse.error.message}` : ''}
            </div>
          ) : listing.length === 0 ? (
            <div className="px-4 py-3 text-[length:var(--client-meta-font-size)] text-[var(--color-text-tertiary)]">没有子目录</div>
          ) : (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              tabIndex={0}
              aria-label="子目录"
              aria-activedescendant={`${listboxId}-option-${activeIndex}`}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const direction = event.key === 'ArrowDown' ? 1 : -1;
                  setActiveIndex((index) => (index + direction + listing.length) % listing.length);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const selected = listing[activeIndex];
                  if (selected !== undefined) {
                    if (event.metaKey || event.ctrlKey) onPick(selected.path);
                    else setPath(selected.path);
                  }
                }
              }}
              className="outline-none"
            >
              {listing.map((entry, index) => (
                <li
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  key={entry.path}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => setPath(entry.path)}
                    onDoubleClick={() => onPick(entry.path)}
                    className={`flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-[var(--color-list-hover)] ${index === activeIndex ? 'bg-[var(--color-list-hover)]' : ''}`}
                  >
                    <Folder
                      size={16}
                      weight="regular"
                      aria-hidden
                      className="shrink-0 text-[var(--color-text-secondary)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[length:var(--client-meta-font-size)] text-[var(--color-text-foreground)]">
                      {entry.name}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-4 py-2">
          <input
            ref={inputRef}
            type="text"
            value={pathInput}
            placeholder={current?.path ?? ''}
            aria-label="目录路径"
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setPath(pathInput === '' ? undefined : pathInput);
              }
            }}
            className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2 py-1 font-mono text-[length:var(--code-font-size)] text-[var(--color-text-foreground)] outline-none focus:border-[var(--color-border-heavy)]"
          />
          <button
            type="button"
            disabled={pathInput === '' || pathInput === current?.path}
            onClick={() => setPath(pathInput)}
            className="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
          >
            前往
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-sm)] px-3 py-1 text-[length:var(--client-meta-font-size)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={current?.path === undefined}
            onClick={() => {
              if (current?.path !== undefined) onPick(current.path);
            }}
            className="rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 py-1 text-[length:var(--client-meta-font-size)] font-medium text-[var(--color-button-primary-foreground)] hover:opacity-90 disabled:opacity-40"
          >
            选择「{current ? basename(current.path) : ''}」
          </button>
        </div>
      </div>
    </div>
  );
}
