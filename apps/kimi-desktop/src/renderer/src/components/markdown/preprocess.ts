/**
 * Markdown preprocessing — Codex-aligned, applied before the marked lexer:
 *
 *  1. (streaming) an unterminated code fence gets closed, so the already
 *     typed portion renders as a code block instead of raw text;
 *  2. fenced code is swapped for placeholders so later rewrites cannot touch
 *     code content;
 *  3. HTML comments are stripped;
 *  4. `<details>` / `<summary>` blocks become `:::github-details` containers;
 *  5. `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` alert blockquotes become
 *     styled directive containers;
 *  6. fence placeholders are restored;
 *  7. (streaming) a trailing, incomplete directive line is dropped so the
 *     half-typed directive does not flash as raw text.
 */

// ------------------------------------------------------------------- fences

/** Length of the currently-open code fence, or `null` when all are closed. */
function openFenceLength(src: string): number | null {
  let fenceLen = 0;
  for (const line of src.split('\n')) {
    const match = /^[ \t]*(`{3,})/.exec(line);
    if (match === null) continue;
    const len = match[1]!.length;
    if (fenceLen === 0) {
      fenceLen = len;
    } else if (len >= fenceLen) {
      fenceLen = 0;
    }
  }
  return fenceLen === 0 ? null : fenceLen;
}

const FENCE_LINE_RE = /^[ \t]*`{3,}/;

function protectFences(src: string, placeholders: string[]): string {
  const lines = src.split('\n');
  let fenceLen = 0;
  const out: string[] = [];
  for (const line of lines) {
    const match = FENCE_LINE_RE.exec(line);
    const isFenceLine = match !== null && (fenceLen === 0 || match[0].trim().length >= fenceLen);
    if (isFenceLine) {
      if (fenceLen === 0) fenceLen = match![0].trim().length;
      else fenceLen = 0;
      placeholders.push(line);
      out.push(placeholderFor(placeholders.length - 1));
      continue;
    }
    if (fenceLen !== 0) {
      // Line inside a fence — never rewrite it (comments, details, alerts).
      placeholders.push(line);
      out.push(placeholderFor(placeholders.length - 1));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function placeholderFor(index: number): string {
  return `\u0000MD_FENCE_${index}\u0000`;
}

function restoreFences(src: string, placeholders: string[]): string {
  const prefix = '\u0000MD_FENCE_';
  return src.replaceAll(/\u0000MD_FENCE_(?:\d+)\u0000/g, (match) => {
    const i = Number(match.slice(prefix.length, -1));
    return i >= 0 && i < placeholders.length ? placeholders[i]! : '';
  });
}

// ------------------------------------------------------------------- rewrites

function stripHtmlComments(src: string): string {
  return src.replaceAll(/<!--[\s\S]*?-->/g, '');
}

function stripHtmlTags(value: string): string {
  return value
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

/** Escape a value for use inside a directive `{attrs}` string. */
function escapeAttr(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll(/\s+/g, ' ').trim();
}

/** `<details>` / `<summary>` blocks → `:::github-details{title="…"}` containers. */
function convertDetails(src: string): string {
  return src.replaceAll(/<details[^>]*>[\s\S]*?<\/details>/gi, (full) => {
    const attrs = /^<details([^>]*)>/i.exec(full)?.[1] ?? '';
    const open = /\bopen\b/i.test(attrs) ? ' open' : '';
    const inner = full.replace(/^<details[^>]*>/i, '').replace(/<\/details>$/i, '');
    const summary = /<summary>([\s\S]*?)<\/summary>/i.exec(inner);
    const title = summary !== null ? stripHtmlTags(summary[1] ?? '').trim() : '';
    const body = inner.replace(/<summary>[\s\S]*?<\/summary>/i, '').trim();
    const titleAttr = title === '' ? '' : ` title="${escapeAttr(title)}"`;
    return `:::github-details{${titleAttr.trim()}${open}}\n${body}\n:::`;
  });
}

const ALERT_RE = /^[ \t]*>[ \t]*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/;

/** `> [!NOTE]` GitHub-style alerts → `:::note` styled directive containers. */
function convertAlerts(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = ALERT_RE.exec(lines[i]!);
    if (match === null) {
      out.push(lines[i]!);
      continue;
    }
    const kind = match[1]!.toLowerCase();
    const body: string[] = [];
    const firstContent = (match[2] ?? '').trim();
    if (firstContent !== '') body.push(firstContent);
    let j = i + 1;
    while (j < lines.length && /^[ \t]*>/.test(lines[j]!)) {
      body.push(lines[j]!.replace(/^[ \t]*>[ \t]?/, ''));
      j += 1;
    }
    i = j - 1;
    out.push(`:::${kind}`);
    if (body.length > 0) out.push(...body);
    out.push(':::');
  }
  return out.join('\n');
}

// ------------------------------------------------------- streaming trimmings

/**
 * Drop a trailing line that is an incomplete directive (an unterminated
 * `:::name` container opener or an inline `:name{…}` without its closing
 * `:`). Applied only while streaming, so a half-typed directive does not
 * render as raw syntax.
 */
function truncateIncompleteDirectiveLine(src: string): string {
  const lines = src.split('\n');
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.trim() === '') i -= 1;
  if (i < 0) return src;
  const line = lines[i]!.trim();
  const isContainerOpener = /^:::[a-zA-Z0-9_-]*(?:\{[^}]*\})?$/.test(line);
  const isInlineOpener = /^:[a-zA-Z0-9_-]+\{[^}]*\}[^:]*$/.test(line);
  if (isContainerOpener || isInlineOpener) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return src;
}

// -------------------------------------------------------------------- export

/**
 * Full preprocessing pipeline. Pure and synchronous — always returns a string,
 * never throws (each rewrite is defensive; a failure at any step still leaves
 * the original content parseable by marked).
 */
export function preprocessMarkdown(source: string, streaming: boolean): string {
  let src = source;

  if (streaming) {
    const openLen = openFenceLength(src);
    if (openLen !== null) {
      const separator = src.endsWith('\n') ? '' : '\n';
      src += `${separator}${'`'.repeat(openLen)}`;
    }
  }

  const placeholders: string[] = [];
  src = protectFences(src, placeholders);
  src = stripHtmlComments(src);
  src = convertDetails(src);
  src = convertAlerts(src);
  src = restoreFences(src, placeholders);

  if (streaming) {
    src = truncateIncompleteDirectiveLine(src);
  }

  return src;
}
