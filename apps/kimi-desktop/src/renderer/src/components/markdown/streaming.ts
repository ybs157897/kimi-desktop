/**
 * streaming.ts — pure helpers for the streaming incremental fade-in.
 *
 * The transcript L1 store always hands the renderer the complete text so far,
 * so `Markdown` re-lexes the whole source on every delta. To reproduce the web
 * version's per-chunk fade (its `text-node-stream-delta` spans), each newly
 * appended suffix is wrapped in `<span class="markdown-stream-delta…">` /
 * `<div …>` markup that `render.tsx` turns into real elements. These helpers
 * decide, purely from the previous and the current source, how to split:
 *
 *  - `none`   — no new text; keep the current chunk structure.
 *  - `inline` — the delta continues the current paragraph; wrap in a span.
 *  - `block`  — the delta starts a fresh block (blank line before it); wrap
 *    in a div so headings / lists / paragraphs keep their block layout.
 *  - `flush`  — the boundary is unsafe for injected markup (open code fence,
 *    unclosed code span / math / citation, trailing half-typed directive) or
 *    the delta is a rewrite/reset; render the plain source and restart the
 *    chunk sequence.
 *
 * Everything here is pure string logic — no lexer, no DOM — so it is
 * unit-testable in the node test environment.
 */

export interface StreamChunk {
  /** Raw text covered by this chunk; chunk texts concatenate to the full source. */
  readonly text: string;
  /** Wrap in a block-level `<div>` (delta started a new block) or inline `<span>`. */
  readonly block: boolean;
  /** Alternating variant (`--a` / `--b`) so adjacent chunks never share an animation name. */
  readonly variant: 0 | 1;
}

export interface StreamState {
  /** Clean source at the last flush (or first mount); chunk markup is appended after it. */
  readonly baseSource: string;
  /** Raw source of the last frame this state was derived from. */
  readonly prevSource: string;
  /** Ordered chunks; `baseSource` + chunk texts concatenate to the current source. */
  readonly chunks: readonly StreamChunk[];
}

export type StreamDeltaKind = 'none' | 'flush' | 'inline' | 'block';

export interface StreamDelta {
  readonly kind: StreamDeltaKind;
  /** The appended suffix (only meaningful for `inline` / `block`). */
  readonly text: string;
}

export function createInitialStreamState(source: string): StreamState {
  return { baseSource: source, prevSource: source, chunks: [] };
}

// ------------------------------------------------------------------ helpers

function commonPrefixLength(prev: string, next: string): number {
  const max = Math.min(prev.length, next.length);
  let i = 0;
  while (i < max && prev.charCodeAt(i) === next.charCodeAt(i)) i += 1;
  return i;
}

/** Fence lines (mirrors the counting in `preprocess.ts`). */
const FENCE_LINE_RE = /^[ \t]*`{3,}/;

/** True when `src` ends inside an open fenced code block. */
export function hasOpenFence(src: string): boolean {
  let fenceLength = 0;
  for (const line of src.split('\n')) {
    const match = FENCE_LINE_RE.exec(line);
    if (match === null) continue;
    const length = match[0].trim().length;
    if (fenceLength === 0) fenceLength = length;
    else if (length >= fenceLength) fenceLength = 0;
  }
  return fenceLength !== 0;
}

function countOccurrences(src: string, needle: string): number {
  let count = 0;
  let index = src.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = src.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Odd unescaped single-dollar delimiters mean an inline formula is open. */
function hasOpenInlineDollar(src: string): boolean {
  const delimiters = src.replaceAll(/\$\$|\\\$/g, '').match(/\$/g);
  return (delimiters?.length ?? 0) % 2 !== 0;
}

/** Net backticks outside fence lines; odd → the tail sits inside an open code span. */
function netInlineBackticks(src: string): number {
  let count = 0;
  for (const line of src.split('\n')) {
    if (FENCE_LINE_RE.test(line)) continue;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '`') count += 1;
    }
  }
  return count;
}

function lastNonEmptyLine(src: string): string {
  const lines = src.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.trim() === '') i -= 1;
  return i < 0 ? '' : lines[i]!.trim();
}

/** Deltas larger than this are treated as rewrites/resets, not streamed text. */
const MAX_STREAM_DELTA_LENGTH = 8192;

// -------------------------------------------------------------- classification

export function splitStreamingDelta(prev: string, next: string): StreamDelta {
  const prefix = commonPrefixLength(prev, next);
  const delta = next.slice(prefix);
  if (delta === '') return { kind: 'none', text: '' };

  // The boundary sits inside an open code fence: injected markup would become
  // literal code content.
  if (hasOpenFence(prev)) return { kind: 'flush', text: '' };
  // The delta opens a fence it does not close: the wrapper would be trapped
  // inside the fence content on the following frames.
  if (hasOpenFence(delta)) return { kind: 'flush', text: '' };
  // Inside an open inline construct, injected markup becomes literal content.
  if (netInlineBackticks(prev) % 2 !== 0) return { kind: 'flush', text: '' };
  if (countOccurrences(prev, '\\(') !== countOccurrences(prev, '\\)')) return { kind: 'flush', text: '' };
  if (countOccurrences(prev, '\\[') !== countOccurrences(prev, '\\]')) return { kind: 'flush', text: '' };
  if (countOccurrences(prev, '$$') % 2 !== 0) return { kind: 'flush', text: '' };
  if (hasOpenInlineDollar(prev)) return { kind: 'flush', text: '' };
  if (countOccurrences(prev, '【') !== countOccurrences(prev, '】')) return { kind: 'flush', text: '' };
  // A trailing half-typed directive would be hidden by the streaming
  // preprocess truncation; wrapped markup would defeat that truncation, so
  // fall back to the plain (truncating) path.
  const tail = lastNonEmptyLine(next);
  if (/^:::[a-zA-Z0-9_-]*(?:\{[^}]*\})?$/.test(tail) || /^:[a-zA-Z0-9_-]+\{[^}]*\}[^:]*$/.test(tail)) {
    return { kind: 'flush', text: '' };
  }
  // A large jump is a reset (session refresh dump), not streamed text.
  if (delta.length > MAX_STREAM_DELTA_LENGTH) return { kind: 'flush', text: '' };

  // A blank line before the delta → the new text is a fresh block.
  if (delta.startsWith('\n\n')) return { kind: 'block', text: delta };

  return { kind: 'inline', text: delta };
}

// ---------------------------------------------------------------- state machine

export function advanceStreamState(state: StreamState, source: string, streaming: boolean): StreamState {
  // Settled frames (and non-streaming mounts) always render the plain source.
  if (!streaming) {
    return state.chunks.length === 0 && state.baseSource === source
      ? state
      : createInitialStreamState(source);
  }
  if (source === state.prevSource) return state;

  const delta = splitStreamingDelta(state.prevSource, source);
  if (delta.kind === 'none') return state;
  if (delta.kind === 'flush') return createInitialStreamState(source);

  const chunks = state.chunks;
  const last = chunks[chunks.length - 1];
  if (delta.kind === 'inline' && last !== undefined && last.block) {
    // Inline continuation of a block-wrapped chunk: grow the wrapper instead
    // of opening a sibling span — a new span would split the paragraph.
    return {
      ...state,
      prevSource: source,
      chunks: [...chunks.slice(0, -1), { ...last, text: last.text + delta.text }],
    };
  }
  const chunk: StreamChunk = {
    text: delta.text,
    block: delta.kind === 'block',
    variant: (chunks.length % 2) as 0 | 1,
  };
  return { ...state, prevSource: source, chunks: [...chunks, chunk] };
}

// ------------------------------------------------------------------ markup build

const STREAM_CLASS = 'markdown-stream-delta';

/** Split trailing newlines off `text` (they live outside inline wrappers). */
function splitTrailingNewlines(text: string): [string, string] {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end -= 1;
  return [text.slice(0, end), text.slice(end)];
}

/**
 * Serialize the state back into a single source string: the clean base source
 * followed by each chunk wrapped in its `<span>` / `<div>` markup. The text
 * content of the result equals the current source exactly.
 */
export function buildStreamedSource(state: StreamState): string {
  const { baseSource, chunks } = state;
  if (chunks.length === 0) return baseSource;

  let out = baseSource;
  for (const chunk of chunks) {
    const suffix = chunk.variant === 0 ? 'a' : 'b';
    const cls = `${STREAM_CLASS} ${STREAM_CLASS}--${suffix}${chunk.block ? ` ${STREAM_CLASS}-block` : ''}`;
    if (chunk.block) {
      // The opening tag must start its own line to lex as block HTML. The
      // closing tag also starts a line so it pairs at block level; a
      // mid-line close degrades into an invisible inline span either way.
      if (out !== '' && !out.endsWith('\n')) out += '\n';
      out += `<div class="${cls}">`;
      out += chunk.text;
      if (!chunk.text.endsWith('\n')) out += '\n';
      out += '</div>';
    } else {
      // Trailing newlines move outside the wrapper so the close tag never
      // sits on its own line inside the paragraph it terminates.
      const [text, trailing] = splitTrailingNewlines(chunk.text);
      out += `<span class="${cls}">${text}</span>${trailing}`;
    }
  }
  return out;
}
