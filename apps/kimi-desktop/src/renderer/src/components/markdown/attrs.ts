/**
 * Directive attribute parsing — the `{attrs}` part of `:::name{attrs}` /
 * `::name{attrs}` / `:name{attrs}`.
 *
 * Grammar (Codex-aligned): a whitespace-separated list of
 *   - `key=value` pairs (bare value: string or number literal),
 *   - quoted strings (`"..."` / `'...'`, backslash escapes the quote),
 *   - bare keys, meaning boolean `true`.
 *
 * Parsing is intentionally forgiving: malformed input yields the attributes
 * parsed so far and never throws, because a bad directive must degrade to
 * plain text instead of taking the whole message down.
 */

export type AttrValue = string | number | boolean;

export type DirectiveAttrs = Readonly<Record<string, AttrValue>>;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*/;
const NUMBER_RE = /^-?(?:\d+|\d*\.\d+)$/;

export function parseAttrs(input: string): DirectiveAttrs {
  const attrs: Record<string, AttrValue> = {};
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i]!)) i += 1;
    if (i >= n) break;
    const keyMatch = KEY_RE.exec(input.slice(i));
    if (keyMatch === null) {
      // Unparseable junk — skip one char and keep going (never throw).
      i += 1;
      continue;
    }
    const key = keyMatch[0];
    i += key.length;
    while (i < n && /\s/.test(input[i]!)) i += 1;
    if (input[i] !== '=') {
      attrs[key] = true; // bare key → boolean
      continue;
    }
    i += 1; // '='
    while (i < n && /\s/.test(input[i]!)) i += 1;
    const quote = input[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let value = '';
      for (; i < n && input[i] !== quote; i += 1) {
        if (input[i] === '\\' && input[i + 1] === quote) {
          value += quote;
          i += 1;
          continue;
        }
        value += input[i];
      }
      i += 1; // closing quote (or past end-of-input when unterminated)
      attrs[key] = value;
      continue;
    }
    const valueMatch = /^[^\s]+/.exec(input.slice(i));
    if (valueMatch === null) {
      attrs[key] = true;
      i += 1;
      continue;
    }
    const raw = valueMatch[0];
    i += raw.length;
    attrs[key] = NUMBER_RE.test(raw) ? Number(raw) : raw;
  }
  return attrs;
}
