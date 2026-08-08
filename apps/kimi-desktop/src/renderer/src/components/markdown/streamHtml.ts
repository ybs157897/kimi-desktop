/**
 * streamHtml.ts — pairing of the streaming fade-in markup into React elements.
 *
 * While streaming, `Markdown` embeds `<span class="markdown-stream-delta…">`
 * / `<div …>` wrappers in the source so each new chunk can fade in. marked
 * lexes those tags as ordinary `html` tokens; `pairStreamHtml` pairs each
 * opening tag with its matching closing tag and renders a real element around
 * the tokens in between, delegating every other token to `renderOne`.
 *
 * Unmatched tags (a wrapper that straddles a block boundary) fall through to
 * the caller's plain html handling — invisible — so streaming degrades
 * gracefully without ever corrupting the text.
 *
 * This module is intentionally dependency-free (react + token types only) so
 * the node test environment can exercise the pairing without dragging in the
 * DOM-dependent markdown components.
 */

import { createElement, type ReactNode } from 'react';
import type { Token } from 'marked';

const STREAM_OPEN_TAG_RE = /^<(span|div)\s+class="([^"]*\bmarkdown-stream-delta\b[^"]*)"\s*>$/;
const STREAM_CLOSE_TAG_RE = /^<\/(span|div)>$/;

interface StreamHtmlGroup {
  readonly tag: 'span' | 'div';
  readonly className: string;
  readonly block: boolean;
}

function matchStreamOpen(token: Token): StreamHtmlGroup | null {
  if (token.type !== 'html') return null;
  const match = STREAM_OPEN_TAG_RE.exec(token.text);
  if (match === null) return null;
  return { tag: match[1] as 'span' | 'div', className: match[2]!, block: token.block === true };
}

function findStreamClose(tokens: readonly Token[], from: number, group: StreamHtmlGroup): number {
  for (let i = from; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type !== 'html' || (token.block === true) !== group.block) continue;
    const match = STREAM_CLOSE_TAG_RE.exec(token.text);
    if (match !== null && match[1] === group.tag) return i;
  }
  return -1;
}

/**
 * Turn a token list into React nodes, grouping each stream-delta wrapper pair
 * into a real `span` / `div` element. `renderOne` handles every non-wrapper
 * token (typically the renderer's per-token switch).
 */
export function pairStreamHtml(
  tokens: readonly Token[],
  renderOne: (token: Token, key: number) => ReactNode,
): ReactNode[] {
  const out: ReactNode[] = [];
  let index = 0;
  while (index < tokens.length) {
    const open = matchStreamOpen(tokens[index]!);
    if (open !== null) {
      const close = findStreamClose(tokens, index + 1, open);
      if (close !== -1) {
        out.push(
          createElement(
            open.tag,
            { key: index, className: open.className },
            pairStreamHtml(tokens.slice(index + 1, close), renderOne),
          ),
        );
        index = close + 1;
        continue;
      }
    }
    out.push(renderOne(tokens[index]!, index));
    index += 1;
  }
  return out;
}
