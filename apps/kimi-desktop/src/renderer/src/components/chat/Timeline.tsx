import { itemId, type AgentState, type TranscriptItem } from '@moonshot-ai/transcript';
import { ArrowDown } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { visibleTimelineItems } from '#/lib/timelinePresentation';
import type { SourcedPendingInteraction } from '#/lib/sessionInteractions';
import { ChatSkeleton } from './ChatSkeleton';
import { TurnBlock } from './TurnBlock';
import { WorkedForSeparator } from './WorkedForSeparator';

export interface TimelineProps {
  /** The store state driving the timeline (items + global entities). */
  readonly state: AgentState;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly onRetry?: (() => void);
  /** Page older turns (before_turn); wired to an IntersectionObserver sentinel
   *  by the host view. */
  readonly onLoadOlder?: (() => void);
  readonly loadingOlder?: boolean;
  /** Session-level pending interactions, including requests owned by subagents. */
  readonly pendingSessionInteractions?: readonly SourcedPendingInteraction[];
}

/** Distance from the bottom below which the viewport counts as "pinned". */
const STICK_BOTTOM_THRESHOLD = 40;
/** How early (above the top edge) the older-turns sentinel fires. */
const SENTINEL_MARGIN = 400;

/** The turn-granular timeline: turns (with worked-for separators), markers,
 *  task refs, and the floating interactions without a loaded anchor frame.
 *
 *  Scroll behavior: pinned to the bottom on first load and while streaming
 *  (only when the user is at the bottom); an older-history prepend restores
 *  the pre-load scroll offset. The top sentinel auto-pages older turns via
 *  `onLoadOlder` (paused while a load error is up — the error banner's retry
 *  re-arms it). */
export function Timeline({
  state,
  loading = false,
  error = null,
  onRetry,
  onLoadOlder,
  loadingOlder = false,
  pendingSessionInteractions = [],
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(true);
  /** Scroll offset from the bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  /** Mirrors `stickBottomRef` for rendering (the floating jump button). */
  const [atBottom, setAtBottom] = useState(true);
  const items = visibleTimelineItems(state.items);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_THRESHOLD;
    stickBottomRef.current = pinned;
    setAtBottom(pinned);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    stickBottomRef.current = true;
    setAtBottom(true);
  }, []);

  const loadOlder = useCallback(() => {
    // Capture the pre-prepend offset; the layout effect below restores it
    // once the older page lands on top of the window.
    const el = scrollRef.current;
    if (el !== null) anchorRef.current = el.scrollHeight - el.scrollTop;
    onLoadOlder?.();
  }, [onLoadOlder]);

  // Scroll restoration / follow: anchor (history prepend) wins, then the
  // pinned-to-bottom rule (first load, streaming follow).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Auto-paging sentinel: fires when the top of the window approaches the
  // viewport. Paused while a page load is in flight and while an error is up
  // (the banner's retry button re-arms it by clearing the error).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (sentinel === null || root === null || !state.hasMoreOlder || error !== null) return;
    if (onLoadOlder === undefined) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadOlder();
      },
      { root, rootMargin: `${SENTINEL_MARGIN}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [state.hasMoreOlder, error, loadingOlder, onLoadOlder, loadOlder]);

  if (loading && items.length === 0) {
    return <ChatSkeleton />;
  }
  if (error !== null && items.length === 0) {
    return <ErrorState onRetry={onRetry} />;
  }
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="relative min-h-0 flex-1 overflow-y-auto bg-[var(--color-background-surface)]"
    >
      <div className="selectable mx-auto w-full max-w-[var(--layout-thread-max-width)] px-6 pb-8 pt-5">
        {error !== null ? (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--red-500)_45%,transparent)] bg-[color-mix(in_srgb,var(--red-500)_12%,transparent)] px-3 py-2 text-[11px] text-[var(--red-400)]">
            <span className="min-w-0 flex-1">加载更早的对话失败。</span>
            {onLoadOlder !== undefined ? (
              <button
                type="button"
                onClick={loadOlder}
                className="shrink-0 cursor-pointer rounded border border-[var(--color-border-heavy)] px-2 py-0.5 hover:bg-[var(--color-list-hover)]"
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        {state.hasMoreOlder ? (
          <div ref={sentinelRef} className="mb-2 flex h-4 items-center justify-center">
            <span className="text-[10px] text-[var(--color-text-foreground)] opacity-40">
              {loadingOlder ? '加载更早的对话…' : ''}
            </span>
          </div>
        ) : null}
        {items.map((item, index) => {
          const previous = index > 0 ? items[index - 1] : undefined;
          return (
            <div key={itemId(item)}>
              {previous?.kind === 'turn' && item.kind === 'turn' ? (
                <WorkedForSeparator turn={previous} nextTurn={item} />
              ) : null}
              <ItemView
                item={item}
                state={state}
                pendingSessionInteractions={pendingSessionInteractions}
              />
            </div>
          );
        })}
      </div>
      {/* Floating "jump to latest": appears when the viewport drifts off the
          bottom (so streaming follow is suspended); smooth-scrolls back. */}
      {!atBottom && items.length > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="跳到最新"
          title="跳到最新"
          className="ui-pressable absolute bottom-5 right-6 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border-heavy)] bg-[var(--color-background-editor-opaque)] text-[var(--color-text-secondary)] shadow-[var(--shadow-lg)] hover:text-[var(--color-text-foreground)]"
        >
          <ArrowDown size={15} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function ErrorState({ onRetry }: { readonly onRetry?: (() => void) }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-background-surface)]">
      <div className="max-w-[32rem] px-4 text-center">
        <div className="text-[15px] font-semibold text-[var(--color-text-foreground)]">暂时无法加载对话</div>
        <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          请检查连接后重试。
        </div>
        {onRetry !== undefined ? (
          <button
            type="button"
            onClick={onRetry}
            className="ui-pressable mt-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ItemView({ item, state, pendingSessionInteractions }: {
  item: TranscriptItem;
  state: AgentState;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
}) {
  switch (item.kind) {
    case 'turn':
      return (
        <TurnBlock
          turn={item}
          tasks={state.tasks}
          interactions={state.interactions}
          attachments={state.attachments}
          pendingSessionInteractions={pendingSessionInteractions}
        />
      );
    case 'marker':
      return (
        <div className="my-4 flex justify-center">
          <span className="rounded-full bg-[var(--color-background-surface-under)] px-2 py-0.5 text-[9.5px] font-medium text-[var(--color-text-tertiary)]">
            {markerLabel(item.marker)}
          </span>
        </div>
      );
    case 'taskref': {
      const task = state.tasks.get(item.taskId);
      return (
        <div className="mb-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2 text-[11px] text-[var(--color-text-foreground)] opacity-80">
          {task?.description ?? item.taskId}
          {task !== undefined ? (
            <span className="ml-2 opacity-60">
              {task.kind} · {task.state}
              {task.detached ? ' (后台)' : ''}
            </span>
          ) : null}
          {task !== undefined && task.outputTail !== '' ? (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] opacity-60">
              {task.outputTail}
            </pre>
          ) : null}
        </div>
      );
    }
  }
}

function markerLabel(marker: string): string {
  if (marker === 'undo') return '已撤销到这里';
  if (marker === 'compact') return '上下文已压缩';
  if (marker === 'swarm.enter') return '蜂群已启动';
  return marker;
}
