import type { V2Session } from '#/lib/api';
import { useArchiveSession } from '#/lib/queries';
import { Archive, PushPin, X } from '@phosphor-icons/react';

export interface SessionListItemProps {
  readonly session: V2Session;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly pinned?: boolean;
  readonly onTogglePin?: () => void;
  /** Lets the shell recover selection and offer a restore/undo affordance. */
  readonly onArchiveSuccess?: ((sessionId: string) => void);
  readonly onArchiveError?: ((sessionId: string, error: Error) => void);
}

/** Status dot tone per `activity.status` (design-doc palette). */
const STATUS_DOT: Record<V2Session['activity']['status'], string> = {
  running: 'bg-[var(--blue-400)]',
  approval: 'bg-[var(--orange-400)]',
  question: 'bg-[var(--purple-400)]',
  failed: 'bg-[var(--red-400)]',
  idle: 'bg-[var(--gray-600)]',
};

/** One compact project-tree row with independently focusable select and archive actions. */
export function SessionListItem({
  session,
  active,
  onClick,
  pinned = false,
  onTogglePin,
  onArchiveSuccess,
  onArchiveError,
}: SessionListItemProps) {
  const archive = useArchiveSession();
  const title = session.meta.title ?? session.meta.lastPrompt ?? '（无标题会话）';
  const hasActivity = session.activity.status !== 'idle';
  const markerColor = hasActivity ? STATUS_DOT[session.activity.status] : 'bg-transparent';

  const runArchive = () => {
    archive.reset();
    archive.mutate(session.id, {
      onSuccess: () => onArchiveSuccess?.(session.id),
      onError: (error) => onArchiveError?.(session.id, error),
    });
  };

  return (
    <div className="group/session w-full">
      <div className="relative">
        <button
          type="button"
          onClick={onClick}
          title={title}
          aria-current={active ? 'page' : undefined}
          className={`flex h-7 w-full cursor-pointer items-center rounded-[var(--radius-sm)] px-1.5 pr-14 text-left outline-none transition-[background-color,color] duration-[var(--duration-hover)] ease focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)] ${
            active
              ? 'bg-[var(--color-list-hover)] text-[var(--color-text-foreground)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
          }`}
        >
          <span
            aria-label={hasActivity ? session.activity.status : undefined}
            aria-hidden={!hasActivity}
            title={hasActivity ? session.activity.status : undefined}
            className={`mr-1.5 h-1.5 w-1.5 shrink-0 rounded-[var(--radius-full)] ${markerColor}`}
          />
          {pinned ? (
            <PushPin
              size={11}
              weight="fill"
              className="mr-1 shrink-0 text-[var(--color-text-accent)]"
              aria-label="已置顶"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[length:var(--client-sidebar-primary-font-size)] font-normal tracking-[var(--tracking-tight)]">
            {title}
          </span>
        </button>
        <div className="absolute top-1/2 right-0.5 flex -translate-y-1/2 items-center gap-0.5">
          {onTogglePin !== undefined ? (
            <button
              type="button"
              aria-label={pinned ? `取消置顶会话：${title}` : `置顶会话：${title}`}
              title={pinned ? '取消置顶' : '置顶会话'}
              onClick={onTogglePin}
              className={`flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover/session:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 ${pinned ? 'text-[var(--color-text-accent)]' : ''}`}
            >
              <PushPin size={12} weight={pinned ? 'fill' : 'regular'} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`归档会话：${title}`}
            title="归档会话"
            disabled={archive.isPending}
            onClick={runArchive}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover/session:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-40"
          >
            <Archive size={12} weight="regular" aria-hidden />
          </button>
        </div>
      </div>
      {archive.isError ? (
        <div
          role="alert"
          className="mx-1 mb-1 flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-error)] bg-[var(--color-background-surface)] px-2 py-1 text-[11px] text-[var(--color-text-danger)]"
        >
          <span className="min-w-0 flex-1 truncate" title={archive.error.message}>
            归档失败：{archive.error.message}
          </span>
          <button
            type="button"
            onClick={runArchive}
            className="shrink-0 rounded-[var(--radius-sm)] px-1 font-medium hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
          <button
            type="button"
            aria-label="关闭归档错误"
            onClick={() => archive.reset()}
            className="shrink-0 rounded-[var(--radius-sm)] p-0.5 hover:bg-[var(--color-list-hover)]"
          >
            <X size={12} weight="bold" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
