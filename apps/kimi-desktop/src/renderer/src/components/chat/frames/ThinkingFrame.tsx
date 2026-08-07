import type { ThinkingFrame as ThinkingFrameModel } from '@moonshot-ai/transcript';
import { useContext } from 'react';

import { TurnContext } from '../frameContext';

export interface ThinkingFrameProps {
  readonly frame: ThinkingFrameModel;
}

/** Reasoning chain (Codex `reasoning`) — muted text, collapsed by default;
 *  the header reads "Thinking" while the turn is live and "Thought for
 *  {elapsed}" once it settled. */
export function ThinkingFrame({ frame }: ThinkingFrameProps) {
  const turn = useContext(TurnContext);
  const label = thinkingLabel(turn?.state, turn?.startedAt, turn?.endedAt, turn?.durationMs);
  return (
    <details className="mb-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2">
      <summary className="cursor-pointer select-none text-[11px] text-[var(--color-text-foreground)] opacity-60 hover:opacity-80">
        {label}
      </summary>
      <div className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-foreground)] opacity-60">
        {frame.text}
      </div>
    </details>
  );
}

function thinkingLabel(
  state: string | undefined,
  startedAt: string | undefined,
  endedAt: string | undefined,
  durationMs: number | undefined,
): string {
  if (state === 'running' || state === 'queued') return 'Thinking';
  const elapsed = durationMs ?? elapsedBetween(startedAt, endedAt);
  return elapsed !== undefined ? `Thought for ${formatElapsed(elapsed)}` : 'Thought';
}

function elapsedBetween(startedAt?: string, endedAt?: string): number | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
