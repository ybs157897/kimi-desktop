import type { NoticeFrame as NoticeFrameModel } from '@moonshot-ai/transcript';

export interface NoticeFrameProps {
  readonly frame: NoticeFrameModel;
}

/** Per-level accent: a left bar color + a text tone. Flat banner (no card
 *  chrome) — just the bar + message, Codex `danger`/`warning` parity. */
const BAR: Record<NoticeFrameModel['level'], string> = {
  error: 'var(--color-text-danger)',
  warning: 'var(--color-text-warning)',
  info: 'var(--color-token-border-heavy)',
};
const TEXT: Record<NoticeFrameModel['level'], string> = {
  error: 'text-[var(--color-text-danger)]',
  warning: 'text-[var(--color-text-warning)]',
  info: 'text-[var(--color-text-secondary)]',
};

/** Error / warning / info banner attached to a step: a flat left-bar accent
 *  (no rounded card, no border, no shadow) with the level label and message. */
export function NoticeFrame({ frame }: NoticeFrameProps) {
  return (
    <div
      className={`ui-card-enter mb-2 max-w-[46rem] border-l-[3px] py-1.5 pl-3 pr-2 text-[12.5px] tracking-[var(--tracking-tight)] ${TEXT[frame.level]}`}
      style={{ borderLeftColor: BAR[frame.level] }}
    >
      <div className="flex items-center gap-2">
        <span className="ui-label !text-inherit">{frame.level}</span>
        {frame.source !== undefined ? (
          <span className="font-mono text-[10.5px] text-[var(--color-token-conversation-summary-trailing)]">{frame.source}</span>
        ) : null}
      </div>
      <div className="mt-0.5 whitespace-pre-wrap leading-[var(--leading-chat)] text-[var(--color-text-foreground)]">{frame.message}</div>
    </div>
  );
}
