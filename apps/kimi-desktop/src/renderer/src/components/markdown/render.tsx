/**
 * render.tsx — recursive tokens → React elements renderer.
 *
 * The marked lexer produces the token stream; this module turns it into
 * React nodes directly (we never round-trip through marked's HTML parser, so
 * extension tokens can render as first-class components). Every token is
 * rendered defensively — a bad token degrades to its raw source instead of
 * crashing the message.
 */

import { createContext, createElement, Fragment, useContext, type ReactNode } from 'react';
import type { Token, Tokens } from 'marked';

import type { CitationToken, DirectiveToken } from './extensions';
import { pairStreamHtml } from './streamHtml';
import { MarkdownCitation } from './MarkdownCitation';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownMath } from './MarkdownMath';

/**
 * Carries the streaming flag down the render tree without threading it through
 * the recursive `renderTokens` signature (which is also used for re-lexed
 * directive bodies where streaming is irrelevant). Markdown.tsx provides the
 * value; the `code` branch consumes it so a live code block shows the trailing
 * cursor and stays unfolded.
 */
export const StreamingContext = createContext(false);
const useStreaming = (): boolean => useContext(StreamingContext);

/** Lexer access for recursive content (container directives). */
export interface RenderContext {
  /** Lex a block-level fragment (container directive bodies). */
  readonly lexBlock: (src: string) => Token[];
  /** Lex an inline fragment. */
  readonly lexInline: (src: string) => Token[];
}

export function renderTokens(tokens: readonly Token[], ctx: RenderContext): ReactNode[] {
  return pairStreamHtml(tokens, (token, key) => renderToken(token, key, ctx));
}

// ------------------------------------------------------------------ renderer

/** A code token rendered with the streaming flag from context (hooks cannot
 *  be called from the recursive `renderToken` switch, so this is a dedicated
 *  component). */
function CodeToken({ text, lang }: { readonly text: string; readonly lang?: string }): ReactNode {
  return <MarkdownCodeBlock code={text} language={lang} streaming={useStreaming()} />;
}

function renderToken(token: Token, key: number, ctx: RenderContext): ReactNode {
  try {
    return renderTokenUnsafe(token, key, ctx);
  } catch {
    return typeof token.raw === 'string' ? token.raw : null;
  }
}

function renderTokenUnsafe(token: Token, key: number, ctx: RenderContext): ReactNode {
  switch (token.type) {
    case 'space':
      return null;
    case 'code':
      return <CodeToken key={key} text={token.text} lang={token.lang} />;
    case 'heading': {
      const depth = Math.min(Math.max(token.depth, 1), 6);
      return createElement(`h${depth}`, { key }, renderTokens(token.tokens ?? [], ctx));
    }
    case 'hr':
      return <hr key={key} />;
    case 'blockquote':
      return <blockquote key={key}>{renderTokens(token.tokens ?? [], ctx)}</blockquote>;
    case 'list':
      return renderList(token as Tokens.List, key, ctx);
    case 'list_item':
      return renderListItem(token as Tokens.ListItem, key, ctx);
    case 'paragraph':
      return <p key={key}>{renderTokens(token.tokens ?? [], ctx)}</p>;
    case 'table':
      return renderTable(token as Tokens.Table, key, ctx);
    case 'html':
      return token.block ? (
        <div key={key} dangerouslySetInnerHTML={{ __html: token.text }} />
      ) : (
        <span key={key} dangerouslySetInnerHTML={{ __html: token.text }} />
      );
    case 'def':
      return null; // link reference definitions leave no visible trace
    case 'escape':
      return token.text;
    case 'text':
      return token.tokens !== undefined && token.tokens.length > 0
        ? renderTokens(token.tokens, ctx)
        : token.text;
    case 'image':
      return renderImage(token as Tokens.Image, key, ctx);
    case 'link':
      return renderLink(token as Tokens.Link, key, ctx);
    case 'strong':
      return <strong key={key}>{renderTokens(token.tokens ?? [], ctx)}</strong>;
    case 'em':
      return <em key={key}>{renderTokens(token.tokens ?? [], ctx)}</em>;
    case 'codespan':
      return <code key={key}>{token.text}</code>;
    case 'br':
      return <br key={key} />;
    case 'del':
      return <del key={key}>{renderTokens(token.tokens ?? [], ctx)}</del>;
    case 'checkbox':
      return <input key={key} type="checkbox" checked={token.checked} disabled readOnly />;
    case 'directive':
      return renderDirective(token as DirectiveToken, key, ctx);
    case 'math':
      return <MarkdownMath key={key} tex={token['tex']} block={token['displayMode']} />;
    case 'citation':
      return renderCitation(token as CitationToken, key);
    default:
      return typeof token.raw === 'string' ? token.raw : null;
  }
}

// ------------------------------------------------------------------- blocks

function renderList(token: Tokens.List, key: number, ctx: RenderContext): ReactNode {
  const items = token.items.map((item, index) => renderListItem(item, index, ctx));
  if (token.ordered) {
    const start = typeof token.start === 'number' && token.start !== 1 ? token.start : undefined;
    return (
      <ol key={key} start={start}>
        {items}
      </ol>
    );
  }
  return <ul key={key}>{items}</ul>;
}

function renderListItem(item: Tokens.ListItem, key: number, ctx: RenderContext): ReactNode {
  const checkbox = item.task ? (
    <input type="checkbox" checked={item.checked === true} disabled readOnly />
  ) : null;
  return (
    <li key={key}>
      {checkbox}
      {renderTokens(item.tokens, ctx)}
    </li>
  );
}

function renderTable(token: Tokens.Table, key: number, ctx: RenderContext): ReactNode {
  const alignStyle = (align: Tokens.TableCell['align']) =>
    align !== null ? { textAlign: align } : undefined;
  return (
    <div key={key} className="markdown-table-shell">
      <table>
        <thead>
          <tr>
            {token.header.map((cell, index) => (
              <th key={index} style={alignStyle(cell.align)}>
                {renderTokens(cell.tokens, ctx)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {token.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} style={alignStyle(cell.align)}>
                  {renderTokens(cell.tokens, ctx)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------- inlines

/** Allowed link targets; anything else (javascript: etc.) renders as text. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

/**
 * Link-shaped file reference heuristic (design doc): the href carries a line
 * anchor and looks like a local path; `scheme://` URLs and plain anchors are
 * excluded.
 */
function citationFromHref(href: string): { path: string; line?: string } | null {
  if (/^(?:https?|wss?|ftp|mailto|tel|file|data|javascript):/i.test(href)) return null;
  if (href.startsWith('#')) return null;
  const match = /^([^#:\s]+?)(?::(\d[\d:-]*)|#(L\d+(?:C\d+)?(?:-L?\d+)?))$/.exec(href);
  if (match === null) return null;
  const path = match[1]!;
  if (path === '' || path.includes('://') || !/[./~]/.test(path)) return null;
  const anchor = match[2] !== undefined ? `L${match[2]}` : match[3]!;
  return { path, line: anchor };
}

function renderLink(token: Tokens.Link, key: number, ctx: RenderContext): ReactNode {
  const citation = citationFromHref(token.href);
  if (citation !== null) {
    return (
      <MarkdownCitation
        key={key}
        citation={{ path: citation.path, line: citation.line, label: token.text }}
      />
    );
  }
  const href = safeHref(token.href);
  if (href === null) {
    return <Fragment key={key}>{renderTokens(token.tokens, ctx)}</Fragment>;
  }
  const external = /^https?:/i.test(href);
  return (
    <a
      key={key}
      href={href}
      title={token.title ?? undefined}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer noopener' : undefined}
    >
      {renderTokens(token.tokens, ctx)}
    </a>
  );
}

function renderImage(token: Tokens.Image, key: number, ctx: RenderContext): ReactNode {
  const src = safeHref(token.href);
  if (src === null) {
    return <Fragment key={key}>{renderTokens(token.tokens, ctx)}</Fragment>;
  }
  return (
    <img
      key={key}
      src={src}
      alt={token.text}
      title={token.title ?? undefined}
      loading="lazy"
      decoding="async"
    />
  );
}

// ---------------------------------------------------------------- extensions

function renderCitation(token: CitationToken, key: number): ReactNode {
  return <MarkdownCitation key={key} citation={{ path: token.path, line: token.line }} />;
}

function renderDirective(token: DirectiveToken, key: number, ctx: RenderContext): ReactNode {
  try {
    switch (token.name) {
      case 'github-details': {
        const title = typeof token.attrs['title'] === 'string' ? token.attrs['title'] : '';
        const open = token.attrs['open'] === true;
        return (
          <details key={key} open={open}>
            {title !== '' ? <summary>{title}</summary> : null}
            {renderTokens(ctx.lexBlock(token.content), ctx)}
          </details>
        );
      }
      case 'note':
      case 'tip':
      case 'important':
      case 'warning':
      case 'caution':
        return (
          <div key={key} className={`markdown-alert markdown-alert-${token.name}`}>
            <div className="markdown-alert-title">{token.name.toUpperCase()}</div>
            <div className="markdown-alert-body">{renderTokens(ctx.lexBlock(token.content), ctx)}</div>
          </div>
        );
      case 'codex-file-citation': {
        const path = typeof token.attrs['path'] === 'string' ? token.attrs['path'] : '';
        const line = typeof token.attrs['line'] === 'string' ? token.attrs['line'] : undefined;
        const label = typeof token.attrs['label'] === 'string' ? token.attrs['label'] : undefined;
        return <MarkdownCitation key={key} citation={{ path, line, label }} />;
      }
      default:
        return token.raw; // unknown directive → raw text
    }
  } catch {
    return token.raw;
  }
}
