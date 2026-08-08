import type { ThinkingFrame as ThinkingFrameModel } from '@moonshot-ai/transcript';
import { CaretRight } from '@phosphor-icons/react';
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

  return (
    <div className="mb-1 max-w-[46rem]">
      <button
        type="button"
        onClick={() => {
          if (live) return;
          setExpandedByUser((value) => !value);
        }}
        aria-expanded={open}
        className="ui-pressable flex h-6 w-fit cursor-pointer select-none items-center gap-1.5 rounded-md px-1 text-[11px] tracking-[var(--tracking-tight)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)]"
      >
        <CaretRight
          size={10}
          weight="bold"
          className={`thinking-caret transition-transform duration-[var(--duration-hover)] ${
            open ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
        {/* Breathing while live (web think-breathe), so a running chain stays
            visually distinct from a settled collapsed label. */}
        <span className={live ? 'ui-breathe' : undefined}>{label}</span>
      </button>
      {open && hasThinkingContent(frame.text) ? (
        <div
          ref={bodyRef}
          onScroll={handleScroll}
          className="mt-1 max-h-[7.5rem] overflow-y-auto whitespace-pre-wrap border-l border-[var(--color-border-light)] py-1 pl-3 text-[12px] leading-[var(--leading-chat)] text-[var(--color-text-tertiary)]"
        >
          {frame.text}
        </div>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
