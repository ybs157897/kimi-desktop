import { useMemo, useRef } from 'react';

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
  readonly onLoadMore?: (() => void);
}

// --------------------------------------------------------------- time groups

type GroupId = 'today' | 'yesterday' | 'week' | 'older';

const GROUP_ORDER: readonly GroupId[] = ['today', 'yesterday', 'week', 'older'];

const GROUP_LABELS: Record<GroupId, string> = {
  today: '今天',
  yesterday: '昨天',
  week: '最近 7 天',
  older: '更早',
};

/** Local-calendar day key (grouping boundary; DST edge cases are acceptable). */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function groupOf(updatedAt: number, now: number): GroupId {
  if (dayKey(updatedAt) === dayKey(now)) return 'today';
  if (dayKey(updatedAt) === dayKey(now - 86_400_000)) return 'yesterday';
  if (now - updatedAt < 7 * 86_400_000) return 'week';
  return 'older';
}

// ------------------------------------------------------------------- footer

const LOAD_MORE_GUARD_MS = 800;

/**
 * The sidebar session list over `GET /api/v2/sessions` (flattened pages),
 * grouped by `meta.updated_at` (today / yesterday / last 7 days / older).
 * Reaching the bottom of the scroller fires `onLoadMore` when `hasMore`; a
 * footer button remains as a fallback for short lists that never scroll.
 */
export function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  loading = false,
  error = null,
  onRetry,
  hasMore = false,
  onLoadMore,
}: SessionListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  const groups = useMemo(() => {
    const byGroup = new Map<GroupId, V2Session[]>();
    for (const group of GROUP_ORDER) byGroup.set(group, []);
    const now = Date.now();
    for (const session of sessions) {
      byGroup.get(groupOf(session.meta.updatedAt, now))?.push(session);
    }
    return [...byGroup.entries()].filter(([, items]) => items.length > 0);
  }, [sessions]);

  const fireLoadMore = () => {
    if (!hasMore || onLoadMore === undefined || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    onLoadMore();
    window.setTimeout(() => {
      loadingMoreRef.current = false;
    }, LOAD_MORE_GUARD_MS);
  };

  if (loading && sessions.length === 0) {
    return <div className="p-3 text-[12px] text-[var(--gray-500)]">正在加载会话…</div>;
  }
  if (error !== null && sessions.length === 0) {
    return (
      <div className="p-3">
        <div className="text-[12px] text-[var(--red-400)]">{error}</div>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-[var(--color-border)] px-2 py-1 text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }
  if (sessions.length === 0) {
    return <div className="p-3 text-[12px] text-[var(--gray-500)]">暂无会话</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={fireLoadMore}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
      >
        {groups.map(([group, items]) => (
          <div key={group} className="mb-2">
            <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold tracking-[0.04em] text-[var(--color-text-tertiary)]">
              {GROUP_LABELS[group]}
            </div>
            {items.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                onClick={() => onSelect(session.id)}
              />
            ))}
          </div>
        ))}
      </div>
      {hasMore ? (
        <div className="border-t border-[var(--color-border-light)] p-1.5">
          {onLoadMore !== undefined ? (
            <button
              type="button"
              onClick={fireLoadMore}
              className="w-full rounded px-2 py-1 text-[11px] text-[var(--gray-500)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
            >
              加载更多
            </button>
          ) : (
            <div className="py-1 text-center text-[11px] text-[var(--gray-600)]">更多会话…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
