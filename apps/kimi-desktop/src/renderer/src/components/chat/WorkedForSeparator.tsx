import type { TranscriptTurn } from '@moonshot-ai/transcript';
import { CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';

export interface WorkedForSeparatorProps {
  /** The turn that just ended (or is still running). */
  readonly turn: TranscriptTurn;
  /** The next turn, when the separator sits between two turns. */
  readonly nextTurn?: TranscriptTurn;
  readonly variant?: 'default' | 'agent';
  /** Current session model label (from `meta.agent.model`), shown inline. */
  readonly modelLabel?: string;
  /** A detected model change across this boundary: `{ from, to }` renders a
   *  dedicated "模型已切换" line. Omitted when the model is unknown or unchanged. */
  readonly modelChange?: { readonly from: string; readonly to: string };
}

/** A quiet, localized status separator between adjacent turns. Collapsible into
 *  a compact summary (zcode `workedFor` parity) with optional model + usage
 *  detail. The model segments degrade gracefully: absent a `meta.agent.model`
 *  feed the separator falls back to duration-only, never erroring. */
export function WorkedForSeparator({
  turn,
  variant = 'default',
  modelLabel,
  modelChange,
}: WorkedForSeparatorProps) {
  const label = separatorLabel(turn, variant);
  const [expanded, setExpanded] = useState(false);
  const detail = turnDetail(turn);
  const hasDetail = detail !== undefined || modelChange !== undefined;
  const modelInline = modelLabel !== undefined && modelLabel !== '' ? ` · ${modelLabel}` : '';

  return (
    <div className="mb-1 mt-3 flex flex-col gap-1 border-t border-[var(--color-border-light)] pt-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => hasDetail && setExpanded((value) => !value)}
          disabled={!hasDetail}
          aria-expanded={expanded}
          className={`flex shrink-0 items-center gap-1 text-[10px] tracking-wide text-[var(--color-text-tertiary)] ${
            hasDetail ? 'ui-pressable cursor-pointer hover:text-[var(--color-text-secondary)]' : 'cursor-default'
          }`}
        >
          {label}
          {modelInline !== '' ? <span className="text-[var(--color-text-tertiary)]/80">{modelInline}</span> : null}
          {hasDetail ? (
            <CaretRight
              size={9}
              weight="bold"
              className={`transition-transform duration-[var(--duration-hover)] ${expanded ? 'rotate-90' : ''}`}
              aria-hidden
            />
          ) : null}
          {variant === 'agent' ? <CaretRight size={9} weight="bold" aria-hidden /> : null}
        </button>
        <div className="h-px min-w-4 flex-1 bg-[var(--color-border-light)]" />
      </div>
      {expanded && hasDetail ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pb-1 pl-1 text-[10px] text-[var(--color-text-tertiary)]">
          {modelChange !== undefined ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[var(--color-tag-plan)]">模型已切换</span>
              <span className="font-mono">{modelChange.from}</span>
              <span aria-hidden>→</span>
              <span className="font-mono">{modelChange.to}</span>
            </span>
          ) : null}
          {detail !== undefined ? <span className="font-mono">{detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** One-line usage summary for the expanded detail row, when usage is present. */
function turnDetail(turn: TranscriptTurn): string | undefined {
  const usage = turn.usage;
  if (usage === undefined) {
    const range = timeRange(turn.startedAt, turn.endedAt);
    return range;
  }
  const parts: string[] = [];
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total > 0) parts.push(`${formatTokens(total)} tokens`);
  if (usage.inputTokens !== undefined) parts.push(`↑ ${formatTokens(usage.inputTokens)}`);
  if (usage.outputTokens !== undefined) parts.push(`↓ ${formatTokens(usage.outputTokens)}`);
  if (usage.cachedTokens !== undefined && usage.cachedTokens > 0) parts.push(`缓存 ${formatTokens(usage.cachedTokens)}`);
  if (usage.cost !== undefined && usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  const range = timeRange(turn.startedAt, turn.endedAt);
  if (range !== undefined) parts.push(range);
  return parts.join(' · ');
}

function timeRange(startedAt?: string, endedAt?: string): string | undefined {
  if (startedAt === undefined) return undefined;
  const fmt = (iso?: string): string | undefined => {
    if (iso === undefined) return undefined;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return undefined;
    return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const start = fmt(startedAt);
  const end = fmt(endedAt);
  if (start === undefined) return undefined;
  return end !== undefined ? `${start} → ${end}` : `${start} →`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function separatorLabel(turn: TranscriptTurn, variant: 'default' | 'agent'): string {
  if (turn.state === 'running' || turn.state === 'queued') return '工作中…';
  const duration = turn.durationMs ?? elapsedBetween(turn.startedAt, turn.endedAt);
  if (variant === 'agent') {
    return duration !== undefined ? `已工作 ${formatAgentDuration(duration)}` : '已完成工作';
  }
  const durationLabel = duration !== undefined ? formatDuration(duration) : undefined;
  switch (turn.state) {
    case 'cancelled':
      return durationLabel !== undefined ? `已停止 · ${durationLabel}` : '已停止';
    case 'failed':
      return durationLabel !== undefined ? `失败 · ${durationLabel}` : '失败';
    default:
      return durationLabel !== undefined ? `耗时 ${durationLabel}` : '已完成';
  }
}

function formatAgentDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function elapsedBetween(startedAt?: string, endedAt?: string): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
