/**
 * GitBranchPicker — a Codex-style local branch switcher shared by the thread
 * summary and the full Git workspace. The popover is portaled so it is not
 * clipped by either dock's scroll container.
 */

import {
  CaretDown,
  Check,
  CircleNotch,
  GitBranch,
  MagnifyingGlass,
  Plus,
} from '@phosphor-icons/react';
import { useIsMutating } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  friendlyGitOperationError,
  gitBranchCreationName,
  gitBranchPickerItems,
} from '#/lib/gitPresentation';
import {
  useFsGitBranches,
  useFsGitCheckout,
  useFsGitCreateBranch,
} from '#/lib/queries';

export interface GitBranchPickerProps {
  readonly sessionId: string;
  readonly currentBranch?: string;
  readonly changedFileCount?: number;
  readonly stagedFileCount?: number;
  readonly repositoryName?: string;
  readonly appearance?: 'environment' | 'toolbar';
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onBranchChanged?: (branch: string) => void;
  readonly onSuccess?: (message: string) => void;
  readonly onError?: (message: string) => void;
}

interface PopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

const POPOVER_WIDTH = 300;
const POPOVER_MAX_HEIGHT = 360;
const VIEWPORT_GUTTER = 8;
const ANCHOR_GAP = 6;

export function GitBranchPicker({
  sessionId,
  currentBranch,
  changedFileCount = 0,
  stagedFileCount = 0,
  repositoryName,
  appearance = 'toolbar',
  disabled = false,
  className = '',
  onBranchChanged,
  onSuccess,
  onError,
}: GitBranchPickerProps) {
  const branches = useFsGitBranches(sessionId);
  const checkout = useFsGitCheckout(sessionId);
  const createBranch = useFsGitCreateBranch(sessionId);
  const mutationCount = useIsMutating({ mutationKey: ['git-mutation', sessionId] });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [branchDraft, setBranchDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const popoverId = useId();
  const listboxId = useId();
  const createInputId = useId();
  const branch = currentBranch ?? branches.data?.current;
  const busy = disabled || mutationCount > 0 || checkout.isPending || createBranch.isPending;

  const branchItems = useMemo(
    () => gitBranchPickerItems(branches.data?.branches ?? [], branch, ''),
    [branch, branches.data?.branches],
  );
  const branchNames = useMemo(() => branchItems.map((item) => item.name), [branchItems]);
  const filteredBranchItems = useMemo(
    () => gitBranchPickerItems(branches.data?.branches ?? [], branch, search),
    [branch, branches.data?.branches, search],
  );
  const creationName = useMemo(
    () => gitBranchCreationName(branchDraft, branchNames),
    [branchDraft, branchNames],
  );
  const creationConflict = branchDraft.trim() !== '' && creationName === null
    ? '该分支已存在，可从本地分支列表直接切换。'
    : null;

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor === undefined) return;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const maxHeight = Math.min(POPOVER_MAX_HEIGHT, window.innerHeight - VIEWPORT_GUTTER * 2);
    const preferredLeft = appearance === 'environment'
      ? anchor.left - width - ANCHOR_GAP
      : anchor.right - width;
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, preferredLeft),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    const spaceBelow = window.innerHeight - anchor.bottom - VIEWPORT_GUTTER;
    const top = appearance === 'environment'
      ? Math.min(
          Math.max(VIEWPORT_GUTTER, anchor.top),
          window.innerHeight - maxHeight - VIEWPORT_GUTTER,
        )
      : spaceBelow >= Math.min(maxHeight, 260)
        ? anchor.bottom + ANCHOR_GAP
        : Math.max(VIEWPORT_GUTTER, anchor.top - maxHeight - ANCHOR_GAP);
    setPosition({ left, top, width, maxHeight });
  }, [appearance]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const update = (): void => updatePosition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [creating, open]);

  useEffect(() => {
    setActiveIndex(filteredBranchItems.length === 0 ? -1 : 0);
  }, [filteredBranchItems.length, search]);

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  useEffect(() => {
    setOpen(false);
    setSearch('');
    setCreating(false);
    setBranchDraft('');
    setError(null);
  }, [sessionId]);

  const close = (restoreFocus = true): void => {
    setOpen(false);
    setSearch('');
    setCreating(false);
    setBranchDraft('');
    setError(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const reportError = (value: unknown, action: string): void => {
    const message = friendlyGitOperationError(value, action);
    setError(message);
    onError?.(message);
  };

  const selectBranch = async (nextBranch: string): Promise<void> => {
    if (busy) return;
    if (nextBranch === branch) {
      close();
      return;
    }
    setError(null);
    try {
      await checkout.mutateAsync(nextBranch);
      onBranchChanged?.(nextBranch);
      onSuccess?.(`已切换到 ${nextBranch}`);
      close();
    } catch (value) {
      reportError(value, '切换分支');
    }
  };

  const createAndCheckout = async (): Promise<void> => {
    const nextBranch = creationName;
    if (nextBranch === null || busy) return;
    setError(null);
    try {
      await createBranch.mutateAsync({ branch: nextBranch, checkout: true });
      onBranchChanged?.(nextBranch);
      onSuccess?.(`已创建并切换到 ${nextBranch}`);
      close();
    } catch (value) {
      reportError(value, '创建分支');
    }
  };

  const moveActive = (direction: 1 | -1): void => {
    if (filteredBranchItems.length === 0) return;
    setActiveIndex((index) => {
      if (index < 0) return direction === 1 ? 0 : filteredBranchItems.length - 1;
      return (index + direction + filteredBranchItems.length) % filteredBranchItems.length;
    });
  };

  const toggle = (): void => {
    if (busy && !open) return;
    if (open) {
      close();
      return;
    }
    setError(null);
    setOpen(true);
  };

  const triggerClassName = appearance === 'environment'
    ? 'ui-pressable flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--color-list-hover)]'
    : 'ui-pressable flex h-8 w-full min-w-0 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 text-left text-[14px] text-[var(--color-text-foreground)] outline-none hover:bg-[var(--color-list-hover)] focus-visible:border-[var(--color-border-focus)] disabled:opacity-50';

  return (
    <div className={`min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="选择 Git 分支"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={busy && !open}
        onClick={toggle}
        className={triggerClassName}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
          <GitBranch size={appearance === 'environment' ? 14 : 16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
          {branch ?? (branches.isError ? '无法读取分支' : '读取分支中…')}
        </span>
        <span className="ml-auto flex shrink-0 items-center text-[var(--color-text-tertiary)]">
          {busy ? (
            <CircleNotch size={12} className="animate-spin" aria-hidden />
          ) : (
            <CaretDown size={appearance === 'environment' ? 11 : 12} aria-hidden />
          )}
        </span>
      </button>

      {open && position !== null
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-40"
                aria-hidden
                onMouseDown={() => close()}
              />
              <div
                id={popoverId}
                role="dialog"
                aria-label="Git 分支"
                aria-busy={busy}
                className="fixed z-50 flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-heavy)] bg-[var(--color-background-panel)] text-[14px] shadow-[var(--shadow-floating-panel)]"
                style={{
                  left: position.left,
                  top: position.top,
                  width: position.width,
                  maxHeight: position.maxHeight,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onBlurCapture={(event) => {
                  const next = event.relatedTarget;
                  if (next instanceof Node && event.currentTarget.contains(next)) return;
                  close(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    if (creating) {
                      setCreating(false);
                      setBranchDraft('');
                      setError(null);
                      window.requestAnimationFrame(() => searchRef.current?.focus());
                    } else {
                      close();
                    }
                  }
                }}
              >
                {creating ? (
                  <form
                    className="flex min-h-0 w-full flex-col"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createAndCheckout();
                    }}
                  >
                    <div className="border-b border-[var(--color-border-light)] px-3 py-3">
                      <label
                        htmlFor={createInputId}
                        className="font-medium text-[var(--color-text-foreground)]"
                      >
                        创建并检出新分支
                      </label>
                      <input
                        id={createInputId}
                        ref={searchRef}
                        value={branchDraft}
                        disabled={busy}
                        onChange={(event) => {
                          setBranchDraft(event.target.value);
                          setError(null);
                        }}
                        placeholder="新分支名称"
                        autoComplete="off"
                        className="mt-2 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2.5 text-[14px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
                      />
                      <p className="mt-2 truncate text-[var(--color-text-tertiary)]">
                        基于当前分支 {branch ?? 'HEAD'}
                      </p>
                      {error === null && creationConflict === null ? null : (
                        <p role="alert" className="mt-2 leading-5 text-[var(--color-text-danger)]">
                          {error ?? creationConflict}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2 px-3 py-2.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setCreating(false);
                          setBranchDraft('');
                          setError(null);
                          window.requestAnimationFrame(() => searchRef.current?.focus());
                        }}
                        className="ui-pressable h-8 rounded-[var(--radius-sm)] px-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
                      >
                        取消
                      </button>
                      <button
                        type="submit"
                        disabled={creationName === null || busy}
                        className="ui-pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 font-medium text-[var(--color-button-primary-foreground)] disabled:opacity-40"
                      >
                        {createBranch.isPending ? <CircleNotch size={14} className="animate-spin" aria-hidden /> : null}
                        创建并检出
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex min-h-0 w-full flex-col">
                    <div className="relative shrink-0 border-b border-[var(--color-border-light)] p-2">
                      <MagnifyingGlass
                        size={14}
                        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]"
                        aria-hidden
                      />
                      <input
                        ref={searchRef}
                        type="search"
                        role="combobox"
                        aria-label="搜索本地 Git 分支"
                        aria-autocomplete="list"
                        aria-expanded="true"
                        aria-controls={listboxId}
                        aria-activedescendant={
                          activeIndex < 0 ? undefined : `${listboxId}-option-${activeIndex}`
                        }
                        value={search}
                        disabled={busy}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault();
                            moveActive(event.key === 'ArrowDown' ? 1 : -1);
                          } else if (event.key === 'Home') {
                            event.preventDefault();
                            if (filteredBranchItems.length > 0) setActiveIndex(0);
                          } else if (event.key === 'End') {
                            event.preventDefault();
                            if (filteredBranchItems.length > 0) {
                              setActiveIndex(filteredBranchItems.length - 1);
                            }
                          } else if (event.key === 'Enter') {
                            event.preventDefault();
                            const selected = filteredBranchItems[activeIndex];
                            if (selected !== undefined) void selectBranch(selected.name);
                          }
                        }}
                        placeholder={repositoryName === undefined ? '搜索本地分支' : `搜索 ${repositoryName} 分支`}
                        autoComplete="off"
                        className="h-9 w-full rounded-[var(--radius-sm)] border border-transparent bg-[var(--color-background-surface-under)] pl-8 pr-2.5 text-[14px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] disabled:opacity-50"
                      />
                    </div>

                    <div
                      id={listboxId}
                      role="listbox"
                      aria-label="本地 Git 分支"
                      className="min-h-0 flex-1 overflow-y-auto py-1"
                    >
                      <div aria-hidden className="px-3 pb-1 pt-1.5 text-[var(--color-text-tertiary)]">
                        分支
                      </div>
                      {branches.isLoading ? (
                        <div className="px-3 py-3 text-[var(--color-text-tertiary)]">读取本地分支中…</div>
                      ) : branches.isError ? (
                        <div role="alert" className="px-3 py-3 text-[var(--color-text-danger)]">
                          无法读取本地分支
                        </div>
                      ) : filteredBranchItems.length === 0 ? (
                        <div className="px-3 py-3 text-[var(--color-text-tertiary)]">没有匹配的本地分支</div>
                      ) : (
                        filteredBranchItems.map(({ name, current }, index) => {
                          const highlighted = index === activeIndex;
                          const showSummary = current && changedFileCount > 0;
                          return (
                            <button
                              ref={(node) => {
                                optionRefs.current[index] = node;
                              }}
                              id={`${listboxId}-option-${index}`}
                              key={name}
                              type="button"
                              role="option"
                              aria-selected={current}
                              tabIndex={-1}
                              disabled={busy}
                              onMouseEnter={() => setActiveIndex(index)}
                              onClick={() => void selectBranch(name)}
                              className={`flex w-full gap-2 px-3 text-left disabled:opacity-50 ${
                                showSummary ? 'min-h-11 items-start py-2' : 'h-9 items-center py-1.5'
                              } ${
                                highlighted ? 'bg-[var(--color-list-hover)]' : ''
                              }`}
                            >
                              <GitBranch
                                size={15}
                                className={`${showSummary ? 'mt-0.5' : ''} shrink-0 text-[var(--color-text-secondary)]`}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[var(--color-text-foreground)]">{name}</span>
                                {showSummary ? (
                                  <span className="mt-0.5 block truncate text-[var(--color-text-tertiary)]">
                                    未提交：{changedFileCount} 个文件
                                    {stagedFileCount > 0 ? ` · 已暂存 ${stagedFileCount}` : ''}
                                  </span>
                                ) : null}
                              </span>
                              {current ? (
                                <Check size={15} weight="bold" className={`${showSummary ? 'mt-0.5' : ''} shrink-0 text-[var(--color-text-secondary)]`} aria-label="当前分支" />
                              ) : null}
                            </button>
                          );
                        })
                      )}
                    </div>

                    {error === null ? null : (
                      <div role="alert" className="shrink-0 border-t border-[var(--color-border-light)] px-3 py-2 leading-5 text-[var(--color-text-danger)]">
                        {error}
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCreating(true);
                        setBranchDraft(search.trim());
                        setError(null);
                      }}
                      className="ui-pressable flex h-10 shrink-0 items-center gap-2 border-t border-[var(--color-border-light)] px-3 text-left font-medium text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:opacity-40"
                    >
                      <Plus size={15} aria-hidden />
                      创建并检出新分支…
                    </button>
                  </div>
                )}
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
