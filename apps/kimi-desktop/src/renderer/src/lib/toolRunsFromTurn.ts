/**
 * Per-turn tool-call grouping for the Codex-style activity summary.
 *
 * Walks a turn's frames (across steps, flattening the step boundary so a run
 * of consecutive commands never splits) and groups consecutive *groupable*
 * tool frames into a single {@link ToolRun} — rendered as one collapsed
 * summary row ("Ran 2 commands · Edited 3 files") that expands to the
 * individual frames. Standalone-only frames (single-Agent spawns, plan
 * reviews, swarm, todo, thinking/text/notice) stay as {@link StandaloneEntry}
 * so they keep their own dedicated card.
 *
 * The grouping is purely presentational — it reads the transcript and emits a
 * flat ordered list consumed by `TurnBlock`; the original frame data is
 * untouched. This mirrors {@link editedFilesFromTurn}'s turn-scope aggregation
 * pattern (a pure renderer-side helper, no backend involvement).
 */

import type { ToolCallFrame, TranscriptFrame, TranscriptTurn } from '@moonshot-ai/transcript';

/** A run of consecutive groupable tool frames, collapsed into one summary. */
export interface ToolRun {
  readonly kind: 'run';
  readonly frames: readonly ToolCallFrame[];
  /** Localized summary parts, e.g. ["编辑了 3 个文件", "运行了 2 条命令"]. */
  readonly summaryParts: readonly string[];
}

/** A single frame that renders on its own (not absorbed into a run). */
export interface StandaloneEntry {
  readonly kind: 'standalone';
  readonly frame: TranscriptFrame;
}

/** The ordered, flattened projection of a turn's frames. */
export type TimelineEntry = ToolRun | StandaloneEntry;

/** Group a turn's frames into runs + standalones, in display order. */
export function toolRunsFromTurn(turn: TranscriptTurn): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let bucket: ToolCallFrame[] = [];

  const flush = (): void => {
    if (bucket.length === 0) return;
    const frames = bucket;
    entries.push({ kind: 'run', frames, summaryParts: summarizeRun(frames) });
    bucket = [];
  };

  for (const step of turn.steps) {
    for (const frame of step.frames) {
      if (frame.kind === 'tool' && isGroupable(frame)) {
        bucket.push(frame);
        continue;
      }
      flush();
      entries.push({ kind: 'standalone', frame });
    }
  }
  flush();
  return entries;
}

/**
 * Groupable tools are the "background noise" Codex collapses: shell commands,
 * file edits/writes, and generic tool calls. Anything with its own dedicated
 * card shape (single Agent, swarm, plan review, todo, search) stays standalone
 * so its bespoke UI is preserved.
 */
function isGroupable(frame: ToolCallFrame): boolean {
  const key = frame.view ?? frame.name;
  // Single Agent / swarm / plan review / todo / search all have bespoke cards.
  if (isStandaloneName(key) || hasStandaloneDisplay(frame)) return false;
  // Bash-style exec, Edit/Write/diff, and unknown/generic tools collapse.
  return true;
}

function isStandaloneName(key: string): boolean {
  return (
    key === 'Agent' ||
    key === 'agent' ||
    key === 'AgentSwarm' ||
    key === 'ExitPlanMode' ||
    key === 'TodoList' ||
    key === 'TodoWrite' ||
    /search/i.test(key)
  );
}

function hasStandaloneDisplay(frame: ToolCallFrame): boolean {
  const display = frame.display;
  if (display === null || typeof display !== 'object' || Array.isArray(display)) return false;
  const kind = (display as { kind?: unknown }).kind;
  return (
    kind === 'agent_call' ||
    kind === 'plan_review' ||
    kind === 'todo_list' ||
    kind === 'search'
  );
}

/** Build the localized summary parts for a run of groupable frames.
 *  Counts commands, file edits, and "other" calls; emits them in a stable
 *  order (files first, then commands, then other), omitting zero counts. */
function summarizeRun(frames: readonly ToolCallFrame[]): string[] {
  let commands = 0;
  let edits = 0;
  let other = 0;
  for (const frame of frames) {
    const key = frame.view ?? frame.name;
    if (isCommandName(key)) {
      commands += 1;
    } else if (isEditName(key) || isEditDisplay(frame.display)) {
      edits += 1;
    } else {
      other += 1;
    }
  }
  const parts: string[] = [];
  if (edits > 0) parts.push(edits === 1 ? '编辑了 1 个文件' : `编辑了 ${edits} 个文件`);
  if (commands > 0) parts.push(commands === 1 ? '运行了 1 条命令' : `运行了 ${commands} 条命令`);
  if (other > 0) parts.push(other === 1 ? '调用了 1 个工具' : `调用了 ${other} 个工具`);
  return parts.length > 0 ? parts : ['执行了操作'];
}

function isCommandName(key: string): boolean {
  return key === 'Bash' || key === 'bash';
}

function isEditName(key: string): boolean {
  return key === 'Edit' || key === 'Write' || key === 'edit' || key === 'write';
}

function isEditDisplay(display: unknown): boolean {
  if (display === null || typeof display !== 'object' || Array.isArray(display)) return false;
  const kind = (display as { kind?: unknown }).kind;
  return kind === 'diff' || kind === 'file_io';
}
