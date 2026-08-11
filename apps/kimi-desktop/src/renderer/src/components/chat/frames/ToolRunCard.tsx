/**
 * ToolRunCard — a collapsed summary of a run of consecutive groupable tool
 * calls (Codex agent-activity-group parity).
 *
 * Folded: one flat activity row (a leading status icon + the localized
 * summary parts + a caret). Expanded: the individual {@link ToolFrame}
 * elements render in place, each still a flat activity row of its own. Live
 * runs (the turn is still working) open by default so progress stays visible;
 * settled runs collapse to the summary.
 *
 * The child frames are passed in as already-built React nodes — TurnBlock
 * owns the interaction/task resolution; this card only owns the disclosure
 * chrome and the collapse/expand motion.
 */

import type { ToolCallFrame } from '@moonshot-ai/transcript';
import { CaretRight, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react';
import { useContext, useState, type ReactNode } from 'react';

import { CollapsibleBody } from '../CollapsibleBody';
import { TurnContext } from '../frameContext';

export interface ToolRunCardProps {
  readonly frames: readonly ToolCallFrame[];
  readonly summaryParts: readonly string[];
  /** Already-built frame nodes (one per entry in `frames`), in order. */
  readonly children: readonly ReactNode[];
}

export function ToolRunCard({ frames, summaryParts, children }: ToolRunCardProps) {
  const turn = useContext(TurnContext);
  const anyLive = frames.some((frame) => frame.state === 'running');
  const live = turn !== null && (turn.state === 'running' || turn.state === 'queued') && anyLive;
  // A run starts expanded while live so the active command stays visible, and
  // collapses to its summary once settled (the user can re-open it). A run of
  // a single frame never collapses — there is nothing to summarize away.
  const single = frames.length === 1;
  const [expandedByUser, setExpandedByUser] = useState<boolean | undefined>(undefined);
  const expanded = single ? true : (expandedByUser ?? live);

  const status = runStatus(frames);
  // While live, the header shows the active verb (the last running frame's
  // action — "正在运行 pnpm test") instead of the settled summary counts, so
  // the user sees what is happening right now (Codex `swl` active-label parity).
  const liveLabel = live ? liveVerb(frames) : undefined;
  const label = liveLabel ?? summaryParts.join(' · ');
  return (
    <div className="ui-card-enter mb-1 max-w-[46rem]">
      {single ? null : (
        <button
          type="button"
          onClick={() => setExpandedByUser((value) => (value === undefined ? !live : !value))}
          aria-expanded={expanded}
          className="ui-pressable group/activity-header -mx-1 flex min-h-8 w-[calc(100%+0.5rem)] cursor-pointer select-none items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[length:var(--codex-chat-font-size)] hover:bg-[var(--color-list-hover)]"
        >
          <RunStatusIcon status={status} live={live} />
          <span
            className={`min-w-0 flex-1 truncate text-[var(--color-token-conversation-summary-leading)] group-hover/activity-header:text-[var(--color-text-foreground)] ${live ? 'ui-shimmer-text' : ''}`}
          >
            {label}
          </span>
          <Caret expanded={expanded} />
        </button>
      )}
      {/* When collapsed (multi-frame run, settled), the detail body is hidden
          and only the summary row remains. When expanded — or always, for a
          single-frame run — each child frame renders its own always-visible
          summary row with its own detail disclosure. */}
      {single ? (
        <div className="flex flex-col gap-[var(--conversation-grouped-item-gap,4px)]">{children}</div>
      ) : (
        <CollapsibleBody open={expanded}>
          <div className="vertical-scroll-fade-mask flex max-h-56 flex-col gap-[var(--conversation-grouped-item-gap,4px)] overflow-y-auto pl-2">
            {children}
          </div>
        </CollapsibleBody>
      )}
    </div>
  );
}

type RunStatus = 'running' | 'done' | 'error';

function runStatus(frames: readonly ToolCallFrame[]): RunStatus {
  let hasError = false;
  let hasRunning = false;
  for (const frame of frames) {
    if (frame.state === 'running') hasRunning = true;
    if (frame.state === 'error') hasError = true;
  }
  if (hasError) return 'error';
  if (hasRunning) return 'running';
  return 'done';
}

/** Derive a live action verb from the last running frame: a shell command
 *  shows "正在运行 <cmd>", a file edit shows "正在编辑文件", otherwise the
 *  tool name. Mirrors Codex's `swl` active-label resolution. */
function liveVerb(frames: readonly ToolCallFrame[]): string {
  const running = [...frames].reverse().find((frame) => frame.state === 'running') ?? frames[frames.length - 1];
  if (running === undefined) return '正在工作';
  const key = running.view ?? running.name;
  const input = running.input !== null && typeof running.input === 'object' && !Array.isArray(running.input)
    ? (running.input as Record<string, unknown>)
    : undefined;
  if (key === 'Bash' || key === 'bash') {
    const command = typeof input?.['command'] === 'string' ? input['command'] : running.inputText;
    return command !== undefined && command !== '' ? `正在运行 ${truncate(command)}` : '正在运行命令';
  }
  if (key === 'Edit' || key === 'Write' || key === 'edit' || key === 'write') {
    return frames.length > 1 ? '正在编辑文件' : '正在编辑文件';
  }
  return `正在调用 ${key}`;
}

function truncate(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function RunStatusIcon({ status, live }: { readonly status: RunStatus; readonly live: boolean }) {
  if (status === 'error') {
    return <WarningCircle size={14} className="shrink-0 text-[var(--color-text-danger)]" aria-hidden />;
  }
  if (live || status === 'running') {
    return <Circle size={14} className="ui-dot-pulse shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
  }
  return <CheckCircle size={14} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
}

function Caret({ expanded }: { readonly expanded: boolean }) {
  return (
    <CaretRight
      size={10}
      weight="bold"
      className={`shrink-0 text-[var(--color-token-conversation-body)] transition-transform duration-[var(--duration-hover)] ${
        expanded
          ? 'rotate-90 opacity-100'
          : 'opacity-0 group-hover/activity-header:opacity-100 group-focus-visible/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:opacity-100'
      }`}
      aria-hidden
    />
  );
}
