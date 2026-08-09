import type { ThinkingFrame as ThinkingFrameModel } from '@moonshot-ai/transcript';
import { Brain, CaretRight } from '@phosphor-icons/react';
import { useContext, useEffect, useRef, useState } from 'react';

import { TurnContext } from '../frameContext';
import { hasThinkingContent } from '#/lib/timelinePresentation';

export interface ThinkingFrameProps {
  readonly frame: ThinkingFrameModel;
  readonly durationMs?: number;
}

/** Reasoning chain (Codex `reasoning`). The body lives in a capped, scrollable
 *  box (≈5 lines) so a long chain never sprawls across the whole timeline.
 *
 *  - Live (this frame is still the tip of a running/queued turn): open by
 *    default, auto-pinned to the newest line while it streams (unless the
 *    user has scrolled up to read earlier text — then we don't yank them
 *    down). Collapses once text / tools arrive after it, even while the turn
 *    is still running.
 *  - Settled: collapsed to a compact "思考过程" toggle; click to expand the
 *    same scrollable box in place. */
export function ThinkingFrame({ frame, durationMs }: ThinkingFrameProps) {
  const turn = useContext(TurnContext);
  const live = turn?.liveTailFrameId === frame.frameId;
  const label = live
    ? '正在思考…'
    : `思考过程${durationMs !== undefined ? ` · 持续了 ${formatDuration(durationMs)}` : ''}`;
  const [expandedByUser, setExpandedByUser] = useState(false);
  const open = live || expandedByUser;

  const bodyRef = useRef<HTMLDivElement>(null);
  // Track whether the body is pinned to the bottom so streaming auto-follow
  // only runs while the user hasn't scrolled up to read history.
  const atBottomRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    const el = bodyRef.current;
    if (el === null) return;
    // A block that just became visible mid-stream must land on its latest line
    // (a refresh can dump the full text with scrollTop 0). After that we only
    // follow when the user is already at the bottom.
    if (live && atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [frame.text, open, live]);

  // On entering a live turn, reset to pinned so the first streamed chunk is
  // followed. When the turn settles we leave the scroll position alone.
  useEffect(() => {
    if (live) atBottomRef.current = true;
  }, [live]);

  const handleScroll = (): void => {
    const el = bodyRef.current;
    if (el === null) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const showBody = open && hasThinkingContent(frame.text);
  return (
    <div className="mb-1.5 max-w-[46rem]">
      <div
        className={`overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-light)] bg-[var(--color-thinking-fill)] ${
          showBody ? 'border-l-2 border-l-[var(--color-thinking-bar)]' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => {
            if (live) return;
            setExpandedByUser((value) => !value);
          }}
          aria-expanded={open}
          className="ui-pressable flex h-7 w-full cursor-pointer select-none items-center gap-1.5 px-2.5 text-left text-[11px] tracking-[var(--tracking-tight)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
        >
          <CaretRight
            size={10}
            weight="bold"
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ${
              open ? 'rotate-90' : ''
            }`}
            aria-hidden
          />
          <Brain
            size={13}
            weight="regular"
            className={`shrink-0 ${live ? 'text-[var(--color-text-accent)]' : 'text-[var(--color-text-tertiary)]'}`}
            aria-hidden
          />
          {/* Live shimmer (zcode animated-gradient-text parity): a gradient sweep
              clipped to the glyphs keeps a running chain visually distinct from a
              settled collapsed label. Settled labels keep a quiet secondary tone. */}
          <span className={`min-w-0 truncate ${live ? 'ui-shimmer-text text-[var(--color-text-foreground)]' : 'text-[var(--color-text-secondary)]'}`}>
            {label}
          </span>
        </button>
        {showBody ? (
          <div
            ref={bodyRef}
            onScroll={handleScroll}
            className="max-h-[10rem] overflow-y-auto whitespace-pre-wrap px-2.5 pb-2.5 pt-0.5 text-[12px] leading-[var(--leading-chat)] text-[var(--color-text-secondary)]"
          >
            {frame.text}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
