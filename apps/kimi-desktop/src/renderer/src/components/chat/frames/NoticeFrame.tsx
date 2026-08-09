import type { NoticeFrame as NoticeFrameModel } from '@moonshot-ai/transcript';

export interface NoticeFrameProps {
  readonly frame: NoticeFrameModel;
}

const TONE: Record<NoticeFrameModel['level'], string> = {
  error:
    'border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] text-[var(--color-text-danger)]',
  warning:
    'border-[var(--color-border-warning)] bg-[color-mix(in_srgb,var(--color-text-warning)_10%,transparent)] text-[var(--color-text-warning)]',
  info: 'border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-secondary)]',
};

/** Error / warning / info banner attached to a step, tinted by level. */
export function NoticeFrame({ frame }: NoticeFrameProps) {
  return (
    <div className={`ui-card-enter mb-3 max-w-[46rem] rounded-xl border px-3.5 py-2.5 text-[12.5px] tracking-[var(--tracking-tight)] ${TONE[frame.level]}`}>
      <div className="flex items-center gap-2">
        <span className="ui-label !text-inherit">{frame.level}</span>
        {frame.source !== undefined ? (
          <span className="font-mono text-[10.5px] text-[var(--color-text-secondary)]">{frame.source}</span>
        ) : null}
      </div>
      <div className="mt-1 whitespace-pre-wrap leading-[var(--leading-chat)] text-[var(--color-text-foreground)]">{frame.message}</div>
    </div>
  );
}
