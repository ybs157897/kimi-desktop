import { CaretDown, DotsThreeVertical, Folder, PlusCircle, X } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';

import type { V2Session } from '#/lib/api';
import { SessionListItem } from './SessionListItem';

export interface SessionListProps {
  readonly sessions: readonly V2Session[];
  readonly activeSessionId?: string;
  readonly onSelect: (sessionId: string) => void;
  readonly onCreateWorkspace?: (cwd: string) => void;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly onRetry?: (() => void);
  readonly hasMore?: boolean;
  readonly loadingMore?: boolean;
  readonly onLoadMore?: (() => void);
  readonly onArchiveSuccess?: ((sessionId: string) => void);
  readonly onArchiveError?: ((sessionId: string, error: Error) => void);
}

interface WorkspaceGroup {
  readonly key: string;
  readonly label: string;
  readonly sessions: readonly V2Session[];
}

const LOAD_MORE_GUARD_MS = 800;
const LOAD_MORE_THRESHOLD_PX = 96;
const HIDDEN_WORKSPACES_KEY = 'app-shell:hidden-workspaces:v1';
const PINNED_SESSIONS_KEY = 'app-shell:pinned-sessions:v1';

function readStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

function writeStringSet(key: string, values: ReadonlySet<string>): void {
  localStorage.setItem(key, JSON.stringify([...values]));
}

/** Project-oriented session tree, matching the desktop's workspace mental model. */
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onCreateWorkspace,
  loading = false,
  error = null,
  onRetry,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onArchiveSuccess,
  onArchiveError,
}: SessionListProps) {
  const loadingMoreRef = useRef(false);
  const [hiddenWorkspaces, setHiddenWorkspaces] = useState<ReadonlySet<string>>(
    () => readStringSet(HIDDEN_WORKSPACES_KEY),
  );
  const [pinnedSessions, setPinnedSessions] = useState<ReadonlySet<string>>(
    () => readStringSet(PINNED_SESSIONS_KEY),
  );
  const [openWorkspaceMenu, setOpenWorkspaceMenu] = useState<string | null>(null);
  const [visibilityOverrides, setVisibilityOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  const groups = useMemo<readonly WorkspaceGroup[]>(() => {
    const byWorkspace = new Map<string, V2Session[]>();
    for (const session of sessions) {
      const key = session.workspace.cwd ?? '__no_workspace__';
      const items = byWorkspace.get(key);
      if (items === undefined) byWorkspace.set(key, [session]);
      else items.push(session);
    }
    return [...byWorkspace.entries()]
      .filter(([key]) => !hiddenWorkspaces.has(key))
      .map(([key, items]) => ({
        key,
        label: key === '__no_workspace__' ? '未指定工作区' : workspaceLabel(key),
        sessions: [...items].sort((left, right) => {
          const leftPinned = pinnedSessions.has(left.id) ? 1 : 0;
          const rightPinned = pinnedSessions.has(right.id) ? 1 : 0;
          return rightPinned - leftPinned;
        }),
      }));
  }, [hiddenWorkspaces, pinnedSessions, sessions]);

  const fireLoadMore = () => {
    if (!hasMore || loadingMore || onLoadMore === undefined || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    onLoadMore();
    window.setTimeout(() => {
      loadingMoreRef.current = false;
    }, LOAD_MORE_GUARD_MS);
  };

  const createSessionInWorkspace = (cwd: string) => {
    setOpenWorkspaceMenu(null);
    onCreateWorkspace?.(cwd);
  };

  const hideWorkspace = (cwd: string) => {
    const next = new Set(hiddenWorkspaces);
    next.add(cwd);
    setHiddenWorkspaces(next);
    writeStringSet(HIDDEN_WORKSPACES_KEY, next);
    setOpenWorkspaceMenu(null);
  };

  const togglePinned = (sessionId: string) => {
    const next = new Set(pinnedSessions);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    setPinnedSessions(next);
    writeStringSet(PINNED_SESSIONS_KEY, next);
  };

  if (loading && sessions.length === 0) {
    return <div className="p-3 text-[length:var(--client-meta-font-size)] text-[var(--color-text-tertiary)]">正在加载会话…</div>;
  }
  if (error !== null && sessions.length === 0) {
    return (
      <div className="p-3">
        <div className="text-[length:var(--client-meta-font-size)] text-[var(--color-text-danger)]">{error}</div>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="ui-pressable mt-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[length:var(--client-meta-font-size)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }
  if (sessions.length === 0) {
    return <div className="p-3 text-[length:var(--client-meta-font-size)] text-[var(--color-text-tertiary)]">暂无会话</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
          if (distanceFromBottom <= LOAD_MORE_THRESHOLD_PX) fireLoadMore();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        <div className="px-2 pb-1.5 pt-3 text-[length:var(--client-meta-font-size)] font-medium text-[var(--color-text-tertiary)]">
          项目
        </div>
        {groups.map((group, index) => {
          const containsActive = group.sessions.some((session) => session.id === activeSessionId);
          const defaultOpen = containsActive || (activeSessionId === undefined && index === 0);
          const open = visibilityOverrides.get(group.key) ?? defaultOpen;
          return (
            <div key={group.key} className="relative mb-1.5">
              <div className="group/project flex h-8 items-center gap-0.5">
                <button
                  type="button"
                  aria-expanded={open}
                  title={group.key === '__no_workspace__' ? group.label : group.key}
                  onClick={() => {
                    setVisibilityOverrides((current) => {
                      const next = new Map(current);
                      next.set(group.key, !open);
                      return next;
                    });
                  }}
                  className="ui-pressable flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] px-2 text-left text-[length:var(--client-sidebar-primary-font-size)] font-semibold tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
                >
                  <Folder size={15} weight="regular" className="shrink-0 text-[var(--color-text-secondary)]" />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <CaretDown
                    size={11}
                    weight="bold"
                    className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${open ? '' : '-rotate-90'}`}
                  />
                </button>
                {group.key !== '__no_workspace__' ? (
                  <>
                    <button
                      type="button"
                      aria-label={`在 ${group.label} 新建任务`}
                      title="新建任务"
                      onClick={() => createSessionInWorkspace(group.key)}
                      className="ui-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover/project:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:opacity-100"
                    >
                      <PlusCircle size={14} weight="regular" aria-hidden />
                    </button>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        aria-label={`项目 ${group.label} 的更多操作`}
                        aria-expanded={openWorkspaceMenu === group.key}
                        title="项目操作"
                        onClick={() => setOpenWorkspaceMenu((current) => (current === group.key ? null : group.key))}
                        className="ui-pressable flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover/project:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:opacity-100"
                      >
                        <DotsThreeVertical size={14} weight="bold" aria-hidden />
                      </button>
                      {openWorkspaceMenu === group.key ? (
                        <div className="absolute right-0 top-full z-30 mt-1 w-40 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-panel)] py-1 shadow-[var(--shadow-floating-panel)]">
                          <button
                            type="button"
                            onClick={() => createSessionInWorkspace(group.key)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
                          >
                            <PlusCircle size={14} aria-hidden />
                            新建任务
                          </button>
                          <button
                            type="button"
                            onClick={() => hideWorkspace(group.key)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
                          >
                            <X size={14} aria-hidden />
                            从侧栏移除
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
              {open ? (
                <div className="ml-[15px] border-l border-[var(--color-border-light)] pl-2">
                  {group.sessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={session}
                      active={session.id === activeSessionId}
                      onClick={() => onSelect(session.id)}
                      pinned={pinnedSessions.has(session.id)}
                      onTogglePin={() => togglePinned(session.id)}
                      onArchiveSuccess={onArchiveSuccess}
                      onArchiveError={onArchiveError}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function workspaceLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}
