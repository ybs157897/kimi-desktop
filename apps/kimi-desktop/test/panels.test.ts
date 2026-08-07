/**
 * Unit tests for the new desktop pure logic: diff rendering helpers and the
 * export filename parser. These are transport-free (no React, no WS) so they
 * run under the existing vitest config.
 */

import { describe, expect, it } from 'vitest';

import { parseExportFilename } from '../src/renderer/src/lib/api';
import {
  countChanges,
  diffBeforeAfter,
  parseUnifiedDiff,
} from '../src/renderer/src/lib/diffRender';
import { serializeContent } from '../src/renderer/src/components/composer/mentions';

describe('diffRender.parseUnifiedDiff', () => {
  it('classifies add/del/context/hunk/meta lines', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' context',
      '-removed',
      '+added',
      '+second',
    ].join('\n');
    const lines = parseUnifiedDiff(diff);
    expect(lines.map((line) => line.type)).toEqual(['meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add']);
    expect(lines.map((line) => line.text)).toEqual([
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,3 @@',
      'context',
      'removed',
      'added',
      'second',
    ]);
  });

  it('returns an empty list for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('treats unrecognized lines as meta', () => {
    const lines = parseUnifiedDiff('diff --git a b');
    expect(lines).toEqual([{ type: 'meta', text: 'diff --git a b' }]);
  });
});

describe('diffRender.diffBeforeAfter', () => {
  it('keeps the common prefix/suffix as context', () => {
    const lines = diffBeforeAfter('a\nold\nz', 'a\nnew\nz');
    expect(lines).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'ctx', text: 'z' },
    ]);
  });

  it('counts add/del lines', () => {
    const lines = diffBeforeAfter('keep\ngo\ngo', 'keep\nnew\nnew\nnew');
    expect(countChanges(lines)).toEqual({ adds: 3, dels: 2 });
  });
});

describe('api.parseExportFilename', () => {
  it('parses a quoted Content-Disposition filename', () => {
    expect(parseExportFilename('attachment; filename="kimi-session-abc.zip"', 'abc')).toBe(
      'kimi-session-abc.zip',
    );
  });

  it('parses an unquoted filename', () => {
    expect(parseExportFilename('attachment; filename=kimi-session-xyz.zip', 'xyz')).toBe(
      'kimi-session-xyz.zip',
    );
  });

  it('falls back to a default when the header is absent', () => {
    expect(parseExportFilename(null, 'sess-1')).toBe('kimi-session-sess-1.zip');
  });

  it('falls back when no filename is present', () => {
    expect(parseExportFilename('attachment', 'sess-2')).toBe('kimi-session-sess-2.zip');
  });
});

describe('mentions.serializeContent', () => {
  it('joins paragraphs with newlines and inlines mention tokens', () => {
    const nodes = [
      {
        type: 'paragraph' as const,
        children: [
          { text: 'edit ' },
          { type: 'mention' as const, mentionType: 'file' as const, value: 'src/index.ts', children: [] },
          { text: ' please' },
        ],
      },
      {
        type: 'paragraph' as const,
        children: [
          { type: 'mention' as const, mentionType: 'command' as const, value: 'review', children: [] },
          { text: ' after' },
        ],
      },
    ];
    expect(serializeContent(nodes as unknown as Parameters<typeof serializeContent>[0])).toBe(
      'edit @src/index.ts please\n/review after',
    );
  });

  it('serializes skill mentions with the $ prefix', () => {
    const nodes = [
      {
        type: 'paragraph' as const,
        children: [{ type: 'mention' as const, mentionType: 'skill' as const, value: 'gen-changesets', children: [] }],
      },
    ];
    expect(serializeContent(nodes as unknown as Parameters<typeof serializeContent>[0])).toBe(
      '$gen-changesets',
    );
  });
});
