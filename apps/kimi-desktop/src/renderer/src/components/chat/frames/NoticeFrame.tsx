import type { NoticeFrame as NoticeFrameModel } from '@moonshot-ai/transcript';

export interface NoticeFrameProps {
  readonly frame: NoticeFrameModel;
}

const TONE: Record<NoticeFrameModel['level'], string> = {
  error:
    'border-[color-mix(in_srgb,var(--red-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--red-500)_12%,transparent)] text-[var(--red-400)]',
  warning:
    'border-[color-mix(in_srgb,var(--orange-400)_45%,transparent)] bg-[color-mix(in_srgb,var(--orange-400)_10%,transparent)] text-[var(--orange-400)]',
  info: 'border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] opacity-80',
};

/** Error / warning / info banner attached to a step, tinted by level. */
export function NoticeFrame({ frame }: NoticeFrameProps) {
  return (
    <div className={`ui-card-enter mb-3 max-w-[46rem] rounded-xl border px-3.5 py-2.5 text-[12.5px] tracking-[var(--tracking-tight)] ${TONE[frame.level]}`}>
      <div className="flex items-center gap-2">
        <span className="ui-label !text-inherit opacity-80">{frame.level}</span>
        {frame.source !== undefined ? (
          <span className="font-mono text-[10.5px] opacity-60">{frame.source}</span>
        ) : null}
      </div>
      <div className="mt-1 whitespace-pre-wrap leading-[var(--leading-chat)] opacity-90">{frame.message}</div>
    </div>
  );
}
