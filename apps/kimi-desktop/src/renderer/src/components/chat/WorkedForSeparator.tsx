import type { TranscriptTurn } from '@moonshot-ai/transcript';

export interface WorkedForSeparatorProps {
  /** The turn that just ended (or is still running). */
  readonly turn: TranscriptTurn;
  /** The next turn, when the separator sits between two turns. */
  readonly nextTurn?: TranscriptTurn;
}

/** A quiet, localized status separator between adjacent turns. */
export function WorkedForSeparator({ turn }: WorkedForSeparatorProps) {
  const label = separatorLabel(turn);
  return (
    <div className="mb-1 mt-3 flex items-center gap-3 border-t border-[var(--color-border-light)] pt-2">
      <span className="text-[10px] tracking-wide text-[var(--color-text-foreground)] opacity-50">
        {label}
      </span>
      <div className="h-px min-w-4 flex-1 bg-[var(--color-border-light)]" />
    </div>
  );
}

function separatorLabel(turn: TranscriptTurn): string {
  if (turn.state === 'running' || turn.state === 'queued') return '工作中…';
  const duration = turn.durationMs ?? elapsedBetween(turn.startedAt, turn.endedAt);
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
