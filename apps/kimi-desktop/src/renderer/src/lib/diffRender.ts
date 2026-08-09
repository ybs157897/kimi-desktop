/**
 * Shared diff rendering helpers — used by the chat tool frame and the diff
 * panel. Two inputs: a `fs:diff` unified-diff string (hunk headers + +/-/ctx
 * lines) and a before/after string pair (the simple old→new line diff used by
 * the tool frame). Both produce a normalized {@link DiffLine} list the
 * consumer renders with {@link diffLineTone} / {@link diffPrefix}.
 */

export type DiffLineType = 'ctx' | 'add' | 'del' | 'hunk' | 'meta';

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
}

/** Parse a unified-diff string into render lines. Lines we don't recognize
 *  (no leading +/-/ /@@) become `meta` so they stay visible but de-emphasized. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (diff === '') return [];
  const lines = diff.split('\n');
  const out: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      out.push({ type: 'meta', text: line });
    } else if (line.startsWith('@@')) {
      out.push({ type: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      out.push({ type: 'add', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      out.push({ type: 'del', text: line.slice(1) });
    } else if (line.startsWith(' ')) {
      out.push({ type: 'ctx', text: line.slice(1) });
    } else {
      out.push({ type: 'meta', text: line });
    }
  }
  return out;
}

/** Simple before→after line diff: keep the common prefix/suffix as context,
 *  mark the middle as removals then additions. Good enough for old/new string
 *  pairs (no LCS backtracking). */
export function diffBeforeAfter(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const lines: DiffLine[] = [];
  for (let i = 0; i < head; i += 1) lines.push({ type: 'ctx', text: a[i] ?? '' });
  for (let i = head; i < a.length - tail; i += 1) lines.push({ type: 'del', text: a[i] ?? '' });
  for (let i = head; i < b.length - tail; i += 1) lines.push({ type: 'add', text: b[i] ?? '' });
  for (let i = b.length - tail; i < b.length; i += 1) lines.push({ type: 'ctx', text: b[i] ?? '' });
  return lines;
}

/** A Write tool's content renders as all-added lines (new file). */
export function addAllLines(content: string): DiffLine[] {
  const body = content.length > 0 && content.endsWith('\n') ? content.slice(0, -1) : content;
  return body.split('\n').map((line) => ({ type: 'add', text: line }));
}

/** Count add/del lines for summary badges. */
export function countChanges(lines: readonly DiffLine[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of lines) {
    if (line.type === 'add') adds += 1;
    else if (line.type === 'del') dels += 1;
  }
  return { adds, dels };
}

/** Tailwind class for a diff line's background/text tone. */
export function diffLineTone(type: DiffLineType): string {
  switch (type) {
    case 'add':
      return 'bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)] text-[var(--color-text-success)]';
    case 'del':
      return 'bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] text-[var(--color-text-danger)]';
    case 'hunk':
      return 'text-[var(--blue-300)] bg-[color-mix(in_srgb,var(--blue-500)_8%,transparent)]';
    case 'meta':
      return 'text-[var(--color-text-foreground)] opacity-50';
    default:
      return 'text-[var(--color-text-foreground)] opacity-60';
  }
}

/** The gutter prefix glyph for a diff line. */
export function diffPrefix(type: DiffLineType): string {
  switch (type) {
    case 'add':
      return '+';
    case 'del':
      return '−';
    case 'hunk':
      return '';
    default:
      return ' ';
  }
}
