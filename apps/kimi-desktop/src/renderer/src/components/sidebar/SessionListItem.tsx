import type { V2Session } from '#/lib/api';
import { useArchiveSession } from '#/lib/queries';
import { X } from '@phosphor-icons/react';

export interface SessionListItemProps {
  readonly session: V2Session;
  readonly active: boolean;
  readonly onClick: () => void;
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
  onArchiveSuccess,
  onArchiveError,
}: SessionListItemProps) {
  const archive = useArchiveSession();
  const title = session.meta.title ?? session.meta.lastPrompt ?? '（无标题会话）';

  const runArchive = () => {
    archive.reset();
    archive.mutate(session.id, {
      onSuccess: () => onArchiveSuccess?.(session.id),
      onError: (error) => onArchiveError?.(session.id, error),
    });
  };

  return (
    <div className="group w-full">
      <div className="relative">
        <button
          type="button"
          onClick={onClick}
          title={title}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg px-2 pr-8 text-left outline-none transition-[background-color,color] duration-[var(--duration-hover)] ease focus-visible:ring-1 focus-visible:ring-[var(--color-border)] ${
            active
              ? 'bg-[var(--color-list-active)] text-[var(--color-text-foreground)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]'
          }`}
        >
          <span
            className={`min-w-0 flex-1 truncate text-[13px] tracking-[var(--tracking-tight)] ${active ? 'font-semibold' : 'font-normal'}`}
          >
            {title}
          </span>
          {session.activity.status !== 'idle' ? (
            <span
              aria-label={session.activity.status}
              title={session.activity.status}
              className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[session.activity.status]}`}
            />
          ) : null}
        </button>
        <button
          type="button"
          aria-label={`归档会话：${title}`}
          title="归档会话"
          disabled={archive.isPending}
          onClick={runArchive}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-[var(--color-text-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:opacity-100 disabled:cursor-wait disabled:opacity-40"
        >
          <X size={11} weight="bold" aria-hidden />
        </button>
      </div>
      {archive.isError ? (
        <div
          role="alert"
          className="mx-1 mb-1 flex items-center gap-1 rounded-md border border-[var(--color-border-error)] bg-[var(--color-background-surface)] px-2 py-1 text-[11px] text-[var(--color-text-danger)]"
        >
          <span className="min-w-0 flex-1 truncate" title={archive.error.message}>
            归档失败：{archive.error.message}
          </span>
          <button
            type="button"
            onClick={runArchive}
            className="shrink-0 rounded px-1 font-medium hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
          <button
            type="button"
            aria-label="关闭归档错误"
            onClick={() => archive.reset()}
            className="shrink-0 rounded p-0.5 hover:bg-[var(--color-list-hover)]"
          >
            <X size={10} weight="bold" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}
