import {
  itemId,
  type AgentState,
  type TranscriptInteraction,
  type TranscriptItem,
} from '@moonshot-ai/transcript';
import type { ApprovalDecision, QuestionResponse } from '@moonshot-ai/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { TurnBlock } from './TurnBlock';
import { WorkedForSeparator } from './WorkedForSeparator';
import { ApprovalCard, type ApprovalResolveHandler, type ApprovalResolveOptions } from './interactions/ApprovalCard';
import { QuestionCard } from './interactions/QuestionCard';

export interface TimelineProps {
  /** The store state driving the timeline (items + global entities). */
  readonly state: AgentState;
  readonly loading?: boolean;
  readonly error?: unknown;
  /** Page older turns (before_turn); wired to an IntersectionObserver sentinel
   *  by the host view. */
  readonly onLoadOlder?: (() => void);
  readonly loadingOlder?: boolean;
  readonly onResolveApproval?: ApprovalResolveHandler;
  readonly onAnswerQuestion?: (
    interaction: TranscriptInteraction,
    response: QuestionResponse,
  ) => void | Promise<void>;
  readonly onDismissQuestion?: (interaction: TranscriptInteraction) => void | Promise<void>;
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
  onLoadOlder,
  loadingOlder = false,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  /** Whether the viewport was pinned to the bottom before the last update. */
  const stickBottomRef = useRef(true);
  /** Scroll offset from the bottom captured before a prepend (restore anchor). */
  const anchorRef = useRef<number | null>(null);
  const items = state.items;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_THRESHOLD;
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
    return <LoadingState />;
  }
  if (error !== null && items.length === 0) {
    return <ErrorState error={error} />;
  }
  const unanchored = unanchoredInteractions(state);
  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-background-surface)]"
    >
      <div className="selectable mx-auto w-full max-w-[46rem] px-6 py-6">
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
        {items.length === 0 ? (
          <EmptyState />
        ) : (
          items.map((item, index) => {
            const previous = index > 0 ? items[index - 1] : undefined;
            return (
              <div key={itemId(item)}>
                {previous?.kind === 'turn' && item.kind === 'turn' ? (
                  <WorkedForSeparator turn={previous} nextTurn={item} />
                ) : null}
                <ItemView
                  item={item}
                  state={state}
                  onResolveApproval={onResolveApproval}
                  onAnswerQuestion={onAnswerQuestion}
                  onDismissQuestion={onDismissQuestion}
                />
              </div>
            );
          })
        )}
        {unanchored.map((interaction) => (
          <div key={interaction.interactionId} className="mt-2">
            <FloatingInteraction
              interaction={interaction}
              onResolveApproval={onResolveApproval}
              onAnswerQuestion={onAnswerQuestion}
              onDismissQuestion={onDismissQuestion}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-background-surface)]">
      <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-foreground)] opacity-50">
        <span className="h-3 w-3 animate-spin rounded-full border border-[var(--color-border-heavy)] border-t-transparent" />
        正在加载对话…
      </div>
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-background-surface)]">
      <div className="max-w-[32rem] px-4 text-center">
        <div className="text-[15px] font-semibold text-[var(--color-text-foreground)]">暂时无法加载对话</div>
        <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          请检查连接后重试。
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[36vh] flex-col items-center justify-center px-2 text-center">
      <div className="text-[16px] font-semibold tracking-[-0.015em] text-[var(--color-text-foreground)]">开始新的对话</div>
      <div className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
        描述你想完成的任务，或添加文件作为上下文。
      </div>
    </div>
  );
}

function ItemView({
  item,
  state,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  item: TranscriptItem;
  state: AgentState;
  onResolveApproval?: TimelineProps['onResolveApproval'];
  onAnswerQuestion?: TimelineProps['onAnswerQuestion'];
  onDismissQuestion?: TimelineProps['onDismissQuestion'];
}) {
  switch (item.kind) {
    case 'turn':
      return (
        <TurnBlock
          turn={item}
          tasks={state.tasks}
          interactions={state.interactions}
          attachments={state.attachments}
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
        />
      );
    case 'marker':
      return (
        <div className="my-2 flex items-center gap-2 text-[10px] text-[var(--color-text-foreground)] opacity-45">
          <div className="h-px flex-1 bg-[var(--color-border-light)]" />
          <span className="font-mono">{item.marker}</span>
          <div className="h-px flex-1 bg-[var(--color-border-light)]" />
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

/** Interactions whose anchor frame is outside the loaded window (or that have
 *  no anchor at all) render floating at the end of the timeline. */
function unanchoredInteractions(state: AgentState): TranscriptInteraction[] {
  const anchored = new Set<string>();
  for (const item of state.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') anchored.add(frame.toolCallId);
      }
    }
  }
  return [...state.interactions.values()].filter(
    (interaction) =>
      interaction.state === 'pending' &&
      (interaction.toolCallId === undefined || !anchored.has(interaction.toolCallId)),
  );
}

function FloatingInteraction({
  interaction,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  interaction: TranscriptInteraction;
  onResolveApproval?: TimelineProps['onResolveApproval'];
  onAnswerQuestion?: TimelineProps['onAnswerQuestion'];
  onDismissQuestion?: TimelineProps['onDismissQuestion'];
}) {
  if (interaction.interactionKind === 'approval' && onResolveApproval !== undefined) {
    return (
      <ApprovalCard
        interaction={interaction}
        onResolve={(decision, options) => onResolveApproval(interaction, decision, options)}
      />
    );
  }
  if (interaction.interactionKind === 'question' && onAnswerQuestion !== undefined) {
    return (
      <QuestionCard
        interaction={interaction}
        onAnswer={(response) => onAnswerQuestion(interaction, response)}
        onDismiss={() => onDismissQuestion?.(interaction)}
      />
    );
  }
  return null;
}
