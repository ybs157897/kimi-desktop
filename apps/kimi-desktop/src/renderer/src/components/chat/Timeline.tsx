import { itemId, type AgentState, type TranscriptItem } from '@moonshot-ai/transcript';
import { ArrowDown } from '@phosphor-icons/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { visibleTimelineItems } from '#/lib/timelinePresentation';
import type { TranscriptPlanInfo } from '#/lib/api';
import type { SourcedPendingInteraction } from '#/lib/sessionInteractions';
import { ChatSkeleton } from './ChatSkeleton';
import { TaskRefCard } from './frames/TaskRefCard';
import type { OpenPlanDoc } from './PlanDocViewer';
import { TurnBlock, type TurnBlockProps } from './TurnBlock';
import { WorkedForSeparator } from './WorkedForSeparator';

export interface TimelineProps {
  /** The store state driving the timeline (items + global entities). */
  readonly state: AgentState;
  readonly loading?: boolean;
  readonly initialError?: unknown;
  readonly error?: unknown;
  readonly onRetry?: (() => void);
  /** Page older turns (before_turn); wired to an IntersectionObserver sentinel
   *  by the host view. */
  readonly onLoadOlder?: (() => void);
  readonly loadingOlder?: boolean;
  /** Session-level pending interactions, including requests owned by subagents. */
  readonly pendingSessionInteractions?: readonly SourcedPendingInteraction[];
  readonly onResolveApproval?: TurnBlockProps['onResolveApproval'];
  readonly onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  readonly onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  /** Open a child agent's transcript in the side panel (swarm / single Agent). */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  /** Open the child-agent overview in the app shell. */
  readonly onOpenSubagents?: () => void;
  /** Open a plan in the plan-document dock tab. */
  readonly onOpenPlanDoc?: OpenPlanDoc;
  /** Durable ExitPlanMode projections, keyed by tool call id. */
  readonly plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  /** Child-agent conversations use a narrower reading column and lead with
   *  the prompt assigned by the parent agent. */
  readonly variant?: 'main' | 'agent';
  readonly introPrompt?: string;
  /** Optimistic state between local submit and the first transcript turn. */
  readonly awaitingTurn?: boolean;
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
  initialError = null,
  error = null,
  onRetry,
  onLoadOlder,
  loadingOlder = false,
  pendingSessionInteractions = [],
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenSubagents,
  onOpenPlanDoc,
  plans,
  variant = 'main',
  introPrompt,
  awaitingTurn = false,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(variant !== 'agent');
  /** Child transcripts open at their assignment, while the main thread keeps
   *  the existing "latest message" entry behavior. */
  const initialScrollRef = useRef(true);
  /** Scroll offset from the bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  /** Mirrors `stickBottomRef` for rendering (the floating jump button). */
  const [atBottom, setAtBottom] = useState(true);
  const items = visibleTimelineItems(state.items);
  const firstTurn = items.find((item) => item.kind === 'turn');
  const modelLabel = state.meta.agent?.model;

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
    if (initialScrollRef.current) {
      el.scrollTop = variant === 'agent' && !awaitingTurn ? 0 : el.scrollHeight;
      if (awaitingTurn) stickBottomRef.current = true;
      initialScrollRef.current = false;
      return;
    }
    if (awaitingTurn) {
      anchorRef.current = null;
      el.scrollTop = el.scrollHeight;
      stickBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    if (anchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      return;
    }
    if (stickBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items, variant, awaitingTurn]);

  // Auto-paging sentinel: fires when the top of the window approaches the
  // viewport. Paused while a page load is in flight and while an error is up
  // (the banner's retry button re-arms it by clearing the error).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (
      sentinel === null ||
      root === null ||
      !state.hasMoreOlder ||
      initialError !== null ||
      error !== null
    ) {
      return;
    }
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
  }, [state.hasMoreOlder, initialError, error, loadingOlder, onLoadOlder, loadOlder]);

  if ((initialError !== null || error !== null) && items.length === 0 && !awaitingTurn) {
    return <ErrorState onRetry={onRetry} />;
  }
  if (loading && items.length === 0 && !awaitingTurn) {
    return <ChatSkeleton />;
  }
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="relative min-h-0 flex-1 overflow-y-auto bg-[var(--color-background-surface)]"
    >
      <div
        className={`selectable mx-auto w-full pb-8 pt-5 ${
          variant === 'agent'
            ? 'max-w-[40rem] px-8'
            : 'max-w-[var(--layout-thread-max-width)] px-6'
        }`}
      >
        {initialError !== null ? (
          <div className="mb-3 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] px-3 py-2 text-[11px] text-[var(--color-text-danger)]">
            <span className="min-w-0 flex-1">暂时无法同步对话。</span>
            {onRetry !== undefined ? (
              <button
                type="button"
                onClick={onRetry}
                className="shrink-0 cursor-pointer rounded-[var(--radius-xs)] border border-[var(--color-border-heavy)] px-2 py-0.5 hover:bg-[var(--color-list-hover)]"
              >
                重试
              </button>
            ) : null}
          </div>
        ) : error !== null ? (
          <div className="mb-3 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border-error)] bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] px-3 py-2 text-[11px] text-[var(--color-text-danger)]">
            <span className="min-w-0 flex-1">加载更早的对话失败。</span>
            {onLoadOlder !== undefined ? (
              <button
                type="button"
                onClick={loadOlder}
                className="shrink-0 cursor-pointer rounded-[var(--radius-xs)] border border-[var(--color-border-heavy)] px-2 py-0.5 hover:bg-[var(--color-list-hover)]"
              >
                重试
              </button>
            ) : null}
          </div>
        ) : null}
        {state.hasMoreOlder ? (
          <div ref={sentinelRef} className="mb-2 flex h-4 items-center justify-center">
            <span className="text-[10px] text-[var(--color-text-tertiary)]">
              {loadingOlder ? '加载更早的对话…' : ''}
            </span>
          </div>
        ) : null}
        {variant === 'agent' && introPrompt !== undefined && introPrompt.trim() !== '' ? (
          <>
            <AgentPrompt prompt={introPrompt} />
            {firstTurn?.kind === 'turn' ? (
              <WorkedForSeparator turn={firstTurn} variant="agent" modelLabel={modelLabel} />
            ) : null}
          </>
        ) : null}
        {items.map((item, index) => {
          const previous = index > 0 ? items[index - 1] : undefined;
          return (
            <div key={itemId(item)}>
              {variant === 'agent' && previous?.kind === 'turn' && item.kind === 'turn' ? (
                <WorkedForSeparator
                  turn={previous}
                  nextTurn={item}
                  variant="agent"
                  modelLabel={modelLabel}
                />
              ) : null}
              <ItemView
                item={item}
                state={state}
                pendingSessionInteractions={pendingSessionInteractions}
                onResolveApproval={variant === 'agent' ? onResolveApproval : undefined}
                onAnswerQuestion={variant === 'agent' ? onAnswerQuestion : undefined}
                onDismissQuestion={variant === 'agent' ? onDismissQuestion : undefined}
                onOpenAgent={onOpenAgent}
                onOpenSubagents={onOpenSubagents}
                onOpenPlanDoc={onOpenPlanDoc}
                plans={plans}
                hidePrompt={
                  variant === 'agent' &&
                  introPrompt !== undefined &&
                  item.kind === 'turn' &&
                  item.prompt?.trim() === introPrompt.trim()
                }
              />
            </div>
          );
        })}
        {awaitingTurn ? <AwaitingTurnPlaceholder /> : null}
      </div>
      {/* Floating "jump to latest": appears when the viewport drifts off the
          bottom (so streaming follow is suspended); smooth-scrolls back.
          Main thread only — child transcripts open at the top and never
          follow the bottom, so the affordance would only ever cover content. */}
      {variant !== 'agent' && !atBottom && items.length > 0 ? (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="跳到最新"
          title="跳到最新"
          className="ui-pressable absolute bottom-5 right-6 z-10 flex h-9 w-9 cursor-pointer items-center justify-center rounded-[var(--radius-full)] border border-[var(--color-border-heavy)] bg-[var(--color-background-panel)] text-[var(--color-text-secondary)] shadow-[var(--shadow-lg)] hover:text-[var(--color-text-foreground)]"
        >
          <ArrowDown size={16} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** Local-only handoff state. It remains visible if transcript transport is
 *  delayed or disconnected, then disappears as soon as a real user turn is
 *  observed and TurnBlock takes over. */
function AwaitingTurnPlaceholder() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="ui-card-enter ui-shimmer-text mb-4 max-w-[46rem] text-[length:var(--codex-chat-font-size)] leading-[var(--markdown-line-height,calc(var(--codex-chat-font-size,14px)+8px))]"
    >
      正在思考…
    </div>
  );
}

function AgentPrompt({ prompt }: { readonly prompt: string }) {
  return (
    <div className="ui-card-enter mb-6 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-user-bubble)] px-4 py-3.5 shadow-[var(--shadow-sm)]">
      <div className="whitespace-pre-wrap text-[14px] leading-[var(--leading-chat)] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)]">
        {prompt}
      </div>
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
            className="ui-pressable mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]"
          >
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ItemView({
  item,
  state,
  pendingSessionInteractions,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenAgent,
  onOpenSubagents,
  onOpenPlanDoc,
  plans,
  hidePrompt = false,
}: {
  item: TranscriptItem;
  state: AgentState;
  pendingSessionInteractions: readonly SourcedPendingInteraction[];
  onResolveApproval?: TurnBlockProps['onResolveApproval'];
  onAnswerQuestion?: TurnBlockProps['onAnswerQuestion'];
  onDismissQuestion?: TurnBlockProps['onDismissQuestion'];
  onOpenAgent?: (agentId: string, prompt?: string) => void;
  onOpenSubagents?: () => void;
  onOpenPlanDoc?: OpenPlanDoc;
  plans?: ReadonlyMap<string, TranscriptPlanInfo>;
  hidePrompt?: boolean;
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
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
          onOpenAgent={onOpenAgent}
          onOpenSubagents={onOpenSubagents}
          onOpenPlanDoc={onOpenPlanDoc}
          plans={plans}
          hidePrompt={hidePrompt}
        />
      );
    case 'marker':
      return (
        <div className="my-4 flex justify-center">
          <span className="rounded-[var(--radius-full)] bg-[var(--color-background-surface-under)] px-2 py-0.5 text-[9.5px] font-medium text-[var(--color-text-tertiary)]">
            {markerLabel(item.marker)}
          </span>
        </div>
      );
    case 'taskref':
      return (
        <TaskRefCard item={item} task={state.tasks.get(item.taskId)} onOpenAgent={onOpenAgent} />
      );
  }
}

function markerLabel(marker: string): string {
  if (marker === 'undo') return '已撤销到这里';
  if (marker === 'compact') return '上下文已压缩';
  if (marker === 'swarm.enter') return '蜂群已启动';
  return marker;
}
