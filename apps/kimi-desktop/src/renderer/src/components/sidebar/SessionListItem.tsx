import type { V2Session } from '#/lib/api';
import { useArchiveSession } from '#/lib/queries';

export interface SessionListItemProps {
  readonly session: V2Session;
  readonly active: boolean;
  readonly onClick: () => void;
}

/** Status dot tone per `activity.status` (design-doc palette). */
const STATUS_DOT: Record<V2Session['activity']['status'], string> = {
  running: 'bg-[var(--blue-400)]',
  approval: 'bg-[var(--orange-400)]',
  question: 'bg-[var(--purple-400)]',
  failed: 'bg-[var(--red-400)]',
  idle: 'bg-[var(--gray-600)]',
};

/** Basename of a POSIX path — the compact project label of the row. */
function cwdLabel(cwd: string): string {
  const parts = cwd.split('/').filter((part) => part !== '');
  return parts.at(-1) ?? cwd;
}

/** Compact Chinese relative time: 刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期. */
function relTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`;
  const date = new Date(epochMs);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const year = sameYear ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * One sidebar row: two lines (title + status dot, cwd + relative time).
 * Archived via the row's hover-only ✕ button (archive mutation lives here —
 * the props contract has no archive callback).
 */
export function SessionListItem({ session, active, onClick }: SessionListItemProps) {
  const archive = useArchiveSession();
  const title = session.meta.title ?? session.meta.lastPrompt ?? '（无标题会话）';
  const cwd = session.workspace.cwd;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      title={title}
      className={`group flex min-h-[50px] w-full cursor-pointer flex-col justify-center rounded-xl px-2.5 py-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-[var(--color-border)] ${
        active ? 'bg-[var(--color-list-active)]' : 'hover:bg-[var(--color-list-hover)]'
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${active ? 'font-semibold' : 'font-medium'} text-[var(--color-text-foreground)]`}>
          {title}
        </span>
        <span
          aria-label={session.activity.status}
          title={session.activity.status}
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[session.activity.status]}`}
        />
        <button
          type="button"
          aria-label="归档会话"
          title="归档会话"
          disabled={archive.isPending}
          onClick={(event) => {
            event.stopPropagation();
            archive.mutate(session.id);
          }}
          className="shrink-0 rounded p-0.5 text-[var(--gray-500)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M1.5 3h9M4.5 3V1.8h3V3M2.8 3l.5 7h5.4l.5-7M5 5v3.5M7 5v3.5" />
          </svg>
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        {cwd !== null ? (
          <span
            title={cwd}
            className="min-w-0 truncate text-[10.5px] text-[var(--color-text-tertiary)]"
          >
            {cwdLabel(cwd)}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-[10.5px] text-[var(--color-text-tertiary)]">
          {relTime(session.meta.updatedAt)}
        </span>
      </div>
    </div>
  );
}
