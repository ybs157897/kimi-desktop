import type { ToolCallFrame, TranscriptFrame, TranscriptTurn } from '@moonshot-ai/transcript';
import { describe, expect, it } from 'vitest';

import { editedFilesFromTurn } from '../src/renderer/src/lib/editedFiles';

// ------------------------------------------------------------------ fixtures

function toolFrame(partial: Partial<ToolCallFrame> & Pick<ToolCallFrame, 'name' | 'state'>): ToolCallFrame {
  return {
    kind: 'tool',
    frameId: `f-${partial.toolCallId ?? Math.random()}`,
    toolCallId: partial.toolCallId ?? `call-${Math.random()}`,
    ...partial,
  };
}

function turnWith(frames: readonly TranscriptFrame[]): TranscriptTurn {
  return {
    kind: 'turn',
    turnId: 't1',
    ordinal: 1,
    state: 'completed',
    origin: { kind: 'user' },
    steps: [
      {
        kind: 'step',
        stepId: 't1.1',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        frames: [...frames],
      },
    ],
  };
}

// ------------------------------------------------------------------ editedFilesFromTurn

describe('editedFilesFromTurn', () => {
  it('counts adds/dels for a single edit from the file_io display', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Edit',
        state: 'done',
        display: {
          kind: 'file_io',
          operation: 'edit',
          path: '/repo/a.ts',
          before: 'a\nb\nc',
          after: 'a\nx\nc',
        },
      }),
    ]);
    expect(editedFilesFromTurn(turn)).toEqual([
      {
        path: '/repo/a.ts',
        adds: 1,
        dels: 1,
        segments: [
          [
            { type: 'ctx', text: 'a' },
            { type: 'del', text: 'b' },
            { type: 'add', text: 'x' },
            { type: 'ctx', text: 'c' },
          ],
        ],
      },
    ]);
  });

  it('counts every line of a Write as an addition', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Write',
        state: 'done',
        display: {
          kind: 'file_io',
          operation: 'write',
          path: '/repo/new.ts',
          content: 'one\ntwo\n',
        },
      }),
    ]);
    const entries = editedFilesFromTurn(turn);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: '/repo/new.ts', adds: 2, dels: 0 });
  });

  it('accumulates repeated edits to the same file in first-seen order', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Edit',
        state: 'done',
        toolCallId: 'c1',
        display: { kind: 'file_io', operation: 'edit', path: '/repo/a.ts', before: 'a\nb', after: 'a\nx' },
      }),
      toolFrame({
        name: 'Edit',
        state: 'done',
        toolCallId: 'c2',
        display: { kind: 'file_io', operation: 'edit', path: '/repo/b.ts', before: 'p', after: 'p\nq\nr' },
      }),
      toolFrame({
        name: 'Edit',
        state: 'done',
        toolCallId: 'c3',
        display: { kind: 'file_io', operation: 'edit', path: '/repo/a.ts', before: 'k', after: 'k\nz' },
      }),
    ]);
    const entries = editedFilesFromTurn(turn);
    expect(entries.map((entry) => entry.path)).toEqual(['/repo/a.ts', '/repo/b.ts']);
    expect(entries[0]).toMatchObject({ adds: 2, dels: 1 });
    expect(entries[0]?.segments).toHaveLength(2);
    expect(entries[1]).toMatchObject({ adds: 2, dels: 0 });
  });

  it('excludes errored and running edit frames', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Edit',
        state: 'error',
        display: { kind: 'file_io', operation: 'edit', path: '/repo/err.ts', before: 'a', after: 'b' },
      }),
      toolFrame({
        name: 'Write',
        state: 'running',
        display: { kind: 'file_io', operation: 'write', path: '/repo/streaming.ts', content: 'x' },
      }),
    ]);
    expect(editedFilesFromTurn(turn)).toEqual([]);
  });

  it('ignores non-edit tools', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Read',
        state: 'done',
        display: { kind: 'file_io', operation: 'read', path: '/repo/a.ts' },
      }),
      toolFrame({
        name: 'Bash',
        state: 'done',
        display: { kind: 'command', command: 'ls' },
      }),
    ]);
    expect(editedFilesFromTurn(turn)).toEqual([]);
  });

  it('falls back to raw input args when no display is present', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Edit',
        state: 'done',
        input: { path: '/repo/raw.ts', old_string: 'foo', new_string: 'bar\nbaz' },
      }),
    ]);
    const entries = editedFilesFromTurn(turn);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: '/repo/raw.ts', adds: 2, dels: 1 });
  });

  it('skips edit frames without a usable path', () => {
    const turn = turnWith([
      toolFrame({
        name: 'Edit',
        state: 'done',
        input: { old_string: 'a', new_string: 'b' },
      }),
    ]);
    expect(editedFilesFromTurn(turn)).toEqual([]);
  });
});
