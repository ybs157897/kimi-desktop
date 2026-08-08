import { CaretDown, Folder } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';

import type { V2Session } from '#/lib/api';
import { SessionListItem } from './SessionListItem';

export interface SessionListProps {
  readonly sessions: readonly V2Session[];
  readonly activeSessionId?: string;
  readonly onSelect: (sessionId: string) => void;
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

/** Project-oriented session tree, matching the desktop's workspace mental model. */
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
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
    return [...byWorkspace.entries()].map(([key, items]) => ({
      key,
      label: key === '__no_workspace__' ? '未指定工作区' : workspaceLabel(key),
      sessions: items,
    }));
  }, [sessions]);

  const fireLoadMore = () => {
    if (!hasMore || loadingMore || onLoadMore === undefined || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    onLoadMore();
    window.setTimeout(() => {
      loadingMoreRef.current = false;
    }, LOAD_MORE_GUARD_MS);
  };

  if (loading && sessions.length === 0) {
    return <div className="p-3 text-[12px] text-[var(--color-text-tertiary)]">正在加载会话…</div>;
  }
  if (error !== null && sessions.length === 0) {
    return (
      <div className="p-3">
        <div className="text-[12px] text-[var(--color-text-danger)]">{error}</div>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="ui-pressable mt-2 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }
  if (sessions.length === 0) {
    return <div className="p-3 text-[12px] text-[var(--color-text-tertiary)]">暂无会话</div>;
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
        <div className="ui-label px-2 pb-1.5 pt-3.5">
          项目
        </div>
        {groups.map((group, index) => {
          const containsActive = group.sessions.some((session) => session.id === activeSessionId);
          const defaultOpen = containsActive || (activeSessionId === undefined && index === 0);
          const open = visibilityOverrides.get(group.key) ?? defaultOpen;
          return (
            <div key={group.key} className="mb-1.5">
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
                className="ui-pressable flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-semibold tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
              >
                <Folder size={15} weight="duotone" className="shrink-0 text-[var(--color-text-secondary)]" />
                <span className="min-w-0 flex-1 truncate">{group.label}</span>
                <CaretDown
                  size={11}
                  weight="bold"
                  className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${open ? '' : '-rotate-90'}`}
                />
              </button>
              {open ? (
                <div className="ml-2.5 border-l border-[var(--color-border-light)] pl-1.5">
                  {group.sessions.map((session) => (
                    <SessionListItem
                      key={session.id}
                      session={session}
                      active={session.id === activeSessionId}
                      onClick={() => onSelect(session.id)}
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
