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
    <div className={`mb-2 rounded-lg border px-3 py-2 text-[12px] ${TONE[frame.level]}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide opacity-80">
          {frame.level}
        </span>
        {frame.source !== undefined ? (
          <span className="font-mono text-[10px] opacity-60">{frame.source}</span>
        ) : null}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap leading-relaxed opacity-90">{frame.message}</div>
    </div>
  );
}
