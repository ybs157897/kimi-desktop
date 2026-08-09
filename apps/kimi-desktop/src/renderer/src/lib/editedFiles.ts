/**
 * Per-turn "edited files" derivation for the end-of-turn summary card
 * (Zed-style "已编辑 N 个文件 +X −Y"). Scans a turn's tool frames for
 * Edit/Write calls and aggregates per-file add/del counts.
 *
 * Data comes straight off the transcript: each edit/write frame carries the
 * path and before/after content in its structured `display` (authoritative,
 * parsed with `ToolInputDisplaySchema`) with the raw tool args in
 * `frame.input` as fallback — the same resolution order as the tool frame's
 * DiffCard. Counts are per-call sums (the same prefix/suffix diff the diff
 * card renders), not a git numstat.
 */

import {
  ToolInputDisplaySchema,
  type ToolInputDisplay,
} from '@moonshot-ai/protocol';
import type { ToolCallFrame, TranscriptTurn } from '@moonshot-ai/transcript';

import {
  addAllLines,
  countChanges,
  diffBeforeAfter,
  type DiffLine,
} from '#/lib/diffRender';

/** One edited file in a turn: aggregated stats plus each call's diff lines,
 *  in call order (a turn can edit the same file more than once). */
export interface EditedFileEntry {
  readonly path: string;
  readonly adds: number;
  readonly dels: number;
  readonly segments: readonly (readonly DiffLine[])[];
}

/** Aggregate the turn's successful Edit/Write calls by path, in first-seen
 *  order. Errored calls didn't land on disk and are excluded. */
export function editedFilesFromTurn(turn: TranscriptTurn): EditedFileEntry[] {
  const byPath = new Map<string, { adds: number; dels: number; segments: DiffLine[][] }>();
  for (const step of turn.steps) {
    for (const frame of step.frames) {
      if (frame.kind !== 'tool' || frame.state !== 'done') continue;
      const edit = editParts(frame);
      if (edit === undefined) continue;
      const { adds, dels } = countChanges(edit.lines);
      let entry = byPath.get(edit.path);
      if (entry === undefined) {
        entry = { adds: 0, dels: 0, segments: [] };
        byPath.set(edit.path, entry);
      }
      entry.adds += adds;
      entry.dels += dels;
      entry.segments.push(edit.lines);
    }
  }
  return [...byPath.entries()].map(([path, entry]) => ({ path, ...entry }));
}

/** Resolve an edit/write frame to its path + diff lines, or undefined when
 *  the frame is not a file edit (or has no usable path). */
function editParts(frame: ToolCallFrame): { path: string; lines: DiffLine[] } | undefined {
  const display = parseDisplay(frame.display);
  const key = frame.view ?? frame.name;
  if (!isEditDisplay(display, key)) return undefined;
  const input = isRecord(frame.input) ? frame.input : undefined;

  let path: string | undefined;
  let before: string | undefined;
  let after: string | undefined;
  let writeContent: string | undefined;
  if (display?.kind === 'file_io') {
    path = display.path;
    if (display.operation === 'write') {
      writeContent = display.content;
    } else {
      before = display.before;
      after = display.after;
    }
  } else if (display?.kind === 'diff') {
    path = display.path;
    before = display.before;
    after = display.after;
  }
  path ??= stringField(input ?? {}, 'path');
  before ??= stringField(input ?? {}, 'old_string');
  after ??= stringField(input ?? {}, 'new_string');
  writeContent ??= stringField(input ?? {}, 'content');
  if (path === undefined || path === '') return undefined;

  const lines =
    writeContent !== undefined ? addAllLines(writeContent) : diffBeforeAfter(before ?? '', after ?? '');
  return { path, lines };
}

/** Mirrors the tool frame's diff dispatch: structured diff/file_io(edit|write)
 *  displays, or a bare Edit/Write tool name. */
function isEditDisplay(display: ToolInputDisplay | undefined, key: string): boolean {
  if (display?.kind === 'diff') return true;
  if (display?.kind === 'file_io') {
    return display.operation === 'edit' || display.operation === 'write';
  }
  return key === 'Edit' || key === 'Write' || key === 'edit' || key === 'write';
}

function parseDisplay(value: unknown): ToolInputDisplay | undefined {
  if (value === undefined) return undefined;
  const parsed = ToolInputDisplaySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
