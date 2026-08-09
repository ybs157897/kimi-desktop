/**
 * Marked extensions for the Kimi Code Desktop markdown pipeline.
 *
 * Three extension families, each tokenizer wrapped in its own try/catch:
 *
 *  - `directive` — the Codex three-level directive syntax:
 *      `:::name{attrs}` container (closed by a line of `:::`),
 *      `::name{attrs}` single-line block,
 *      `:name{attrs}` / `:name{attrs} content :` inline.
 *    Unknown names and malformed syntax return `undefined`, so marked falls
 *    back to the raw text — a bad directive must never crash the message.
 *  - `math` — KaTeX delimiters: block `$$…$$` / `\[…\]` and inline `$…$` / `\(…\)`
 *    (plus an inline `\[…\]` fallback for mid-paragraph display math).
 *  - `citation` — file references: literal `【path†L12】` / `【F:…†L12-L40】`
 *    and link-shaped bare text `path:12`, `path:12:4-40:8`, `path#L12C4`.
 *
 * Attribute syntax lives in `./attrs`; rendering of the produced tokens
 * happens in `./render` (we never run these through marked's HTML parser —
 * the tokens carry enough data for React components).
 */

import type {
  MarkedExtension,
  TokenizerAndRendererExtension,
  TokenizerExtension,
  Tokens,
} from 'marked';

import { parseAttrs, type DirectiveAttrs } from './attrs';

// ---------------------------------------------------------------- token types

export interface DirectiveToken extends Tokens.Generic {
  readonly type: 'directive';
  /** `container` (:::) / `block` (::) / `inline` (:) level. */
  readonly kind: 'container' | 'block' | 'inline';
  readonly name: string;
  readonly attrs: DirectiveAttrs;
  /** Inner content, lexed recursively by the renderer. */
  readonly content: string;
}

export interface MathToken extends Tokens.Generic {
  readonly type: 'math';
  readonly tex: string;
  readonly displayMode: boolean;
}

export interface CitationToken extends Tokens.Generic {
  readonly type: 'citation';
  /** File path as written (`F:` prefix means percent-encoded). */
  readonly path: string;
  /** Line anchor, e.g. `L12` or `L12-L40`. */
  readonly line?: string;
}

// --------------------------------------------------------------- known names

/** Container directives that render as styled blocks (unknown → raw text). */
const CONTAINER_NAMES = new Set([
  'github-details',
  'note',
  'tip',
  'important',
  'warning',
  'caution',
]);

/** Single-line block directives (Codex `::codex-file-citation` kept, others cut). */
const BLOCK_NAMES = new Set(['codex-file-citation']);

/** Inline directives. */
const INLINE_NAMES = new Set(['codex-file-citation']);

// ------------------------------------------------------------------ directive

/** `:::name{attrs}` container — closes on the matching line of `:::`. */
const containerDirective: TokenizerExtension = {
  name: 'directiveContainer',
  level: 'block',
  start(src) {
    const idx = src.search(/\n[ \t]*:::[a-zA-Z0-9_-]/);
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src) {
    const match = /^[ \t]*:::([a-zA-Z0-9_-]+)(?:\{([^}]*)\})?[ \t]*([^\n]*)/.exec(src);
    if (match === null || !CONTAINER_NAMES.has(match[1]!)) return undefined;
    const name = match[1]!;
    const attrs = parseAttrs(match[2] ?? '');
    const inlineStart = match[3] ?? '';

    // Depth-scan the following lines so nested `:::a … :::` containers are
    // paired correctly; the first `:::` at depth zero closes this one.
    const lines = src.split('\n');
    let depth = 1;
    let endLine = -1;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (/^:::[a-zA-Z0-9_-]/.test(line.trim())) {
        depth += 1;
      } else if (/^[ \t]*:::[ \t]*$/.test(line)) {
        depth -= 1;
        if (depth === 0) {
          endLine = i;
          break;
        }
      }
    }
    if (endLine === -1) return undefined; // unterminated → raw text

    const contentLines: string[] = [];
    if (inlineStart.trim() !== '') contentLines.push(inlineStart);
    for (let i = 1; i < endLine; i += 1) contentLines.push(lines[i]!);

    const token: DirectiveToken = {
      type: 'directive',
      kind: 'container',
      name,
      attrs,
      content: contentLines.join('\n'),
      raw: lines.slice(0, endLine + 1).join('\n'),
    };
    return token;
  },
};

/** `::name{attrs}` single-line block directive. */
const blockDirective: TokenizerExtension = {
  name: 'directiveBlock',
  level: 'block',
  start(src) {
    const idx = src.search(/\n[ \t]*::[a-zA-Z0-9_-]/);
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src) {
    const match = /^[ \t]*::([a-zA-Z0-9_-]+)(?:\{([^}]*)\})?[ \t]*([^\n]*)/.exec(src);
    if (match === null || !BLOCK_NAMES.has(match[1]!)) return undefined;
    const token: DirectiveToken = {
      type: 'directive',
      kind: 'block',
      name: match[1]!,
      attrs: parseAttrs(match[2] ?? ''),
      content: match[3] ?? '',
      raw: match[0],
    };
    return token;
  },
};

/** `:name{attrs}` self-closing or `:name{attrs} content :` inline directive. */
const inlineDirective: TokenizerExtension = {
  name: 'directiveInline',
  level: 'inline',
  start(src) {
    const idx = src.search(/:[a-zA-Z0-9_-]+\{/);
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src) {
    const match = /^:([a-zA-Z0-9_-]+)(?:\{([^}]*)\})?/.exec(src);
    if (match === null || !INLINE_NAMES.has(match[1]!)) return undefined;
    const name = match[1]!;
    const attrs = parseAttrs(match[2] ?? '');
    const rest = src.slice(match[0].length);
    if (rest === '' || rest[0] === ':' || /^[\s]/.test(rest)) {
      // Self-closing `:name{attrs}`.
      const token: DirectiveToken = {
        type: 'directive',
        kind: 'inline',
        name,
        attrs,
        content: '',
        raw: match[0],
      };
      return token;
    }
    // Paired `:name{attrs} content :` — content runs to the next `:` and
    // must not cross a line; otherwise fall back to raw text.
    const contentMatch = /^([^\n]*?):/.exec(rest);
    if (contentMatch === null) return undefined;
    const token: DirectiveToken = {
      type: 'directive',
      kind: 'inline',
      name,
      attrs,
      content: contentMatch[1] ?? '',
      raw: match[0] + contentMatch[0],
    };
    return token;
  },
};

// ----------------------------------------------------------------------- math

function mathBlockExtension(name: string, rule: RegExp): TokenizerExtension {
  return {
    name,
    level: 'block',
    start(src) {
      const idx = src.search(/\n\$\$|\n\\\[/);
      return idx === -1 ? undefined : idx;
    },
    tokenizer(src) {
      const match = rule.exec(src);
      if (match === null) return undefined;
      const token: MathToken = {
        type: 'math',
        tex: (match[1] ?? '').trim(),
        displayMode: true,
        raw: match[0],
      };
      return token;
    },
  };
}

function mathInlineExtension(name: string, rule: RegExp, displayMode: boolean): TokenizerExtension {
  return {
    name,
    level: 'inline',
    start(src) {
      const idx = src.search(/\$|\\\(|\\\[/);
      return idx === -1 ? undefined : idx;
    },
    tokenizer(src) {
      const match = rule.exec(src);
      if (match === null) return undefined;
      const token: MathToken = {
        type: 'math',
        tex: (match[1] ?? '').trim(),
        displayMode,
        raw: match[0],
      };
      return token;
    },
  };
}

const blockDollarMath = mathBlockExtension('mathBlockDollar', /^ {0,3}\$\$([\s\S]+?)\$\$(?:\n+|$)/);
const blockBracketMath = mathBlockExtension('mathBlockBracket', /^ {0,3}\\\[([\s\S]+?)\\\](?:\n+|$)/);
const inlineDollarMath = mathInlineExtension(
  'mathInlineDollar',
  /^\$(?!\$)(?!\s)((?:\\.|[^\\$\n])*?\S)\$(?!\$)/,
  false,
);
const inlineParenMath = mathInlineExtension('mathInlineParen', /^\\\(([\s\S]+?)\\\)/, false);
// Mid-paragraph `\[…\]` still renders as display math rather than being
// swallowed by markdown escaping.
const inlineBracketMath = mathInlineExtension('mathInlineBracket', /^\\\[([\s\S]+?)\\\]/, true);

// ------------------------------------------------------------------- citation

const LINE_ANCHOR_RE = /^(?:L?\d[\d:-]*|L\d+(?:C\d+)?(?:-L?\d+)?)$/;

/** Literal `【path†L12】` / `【path†L12-L40】` / `【F:percent-encoded†L12】`. */
const literalCitation: TokenizerExtension = {
  name: 'citationLiteral',
  level: 'inline',
  start(src) {
    const idx = src.search(/【[^【\n]*†/);
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src) {
    const match = /^【([^】\n]+?)†([^】\n]+?)】/.exec(src);
    if (match === null) return undefined;
    const line = match[2]!;
    if (!LINE_ANCHOR_RE.test(line)) return undefined; // not a line anchor → raw text
    const token: CitationToken = {
      type: 'citation',
      path: match[1]!,
      line,
      raw: match[0],
    };
    return token;
  },
};

/**
 * Link-shaped bare text references: `path:12`, `path:12:4-40:8`, `path#L12C4`.
 * Heuristic (design doc): the text must look like a local file path — an
 * extension-carrying path without a `scheme://` — followed by a line anchor.
 */
const linkShapedCitation: TokenizerExtension = {
  name: 'citationLinkShaped',
  level: 'inline',
  start(src) {
    const idx = src.search(
      /(?<![A-Za-z0-9])(?<!:\/\/)(?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_.~/-]*\.[A-Za-z0-9]{1,8}[:#]\d|(?<![A-Za-z0-9])[A-Za-z0-9_./~-]+\.[A-Za-z0-9]{1,8}#L\d/,
    );
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src) {
    const match = /^((?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_.~/-]*\.[A-Za-z0-9]{1,8})(?::(\d[\d:-]*)|#(L\d+(?:C\d+)?(?:-L?\d+)?))/.exec(
      src,
    );
    if (match === null) return undefined;
    const path = match[1]!;
    if (path.includes('://')) return undefined; // scheme URLs are not citations
    const anchor = match[2] !== undefined ? `L${match[2]}` : match[3];
    if (anchor === undefined) return undefined;
    const token: CitationToken = {
      type: 'citation',
      path,
      line: anchor,
      raw: match[0],
    };
    return token;
  },
};

// ------------------------------------------------------------------- assembly

/** Wrap a tokenizer so a throwing extension degrades to raw text. */
function guarded(extension: TokenizerExtension): TokenizerExtension {
  const { tokenizer } = extension;
  return {
    ...extension,
    tokenizer(src, tokens) {
      try {
        return tokenizer.call(this, src, tokens);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * All markdown extensions, each independently guarded: one broken extension
 * must never take the whole message down. Also disables the standard
 * `~~strikethrough~~` — the del tokenizer returns `undefined` (not `false`,
 * which marked v18 treats as "fall back to the built-in implementation").
 */
export function createMarkdownExtensions(): MarkedExtension {
  const extensions: TokenizerAndRendererExtension[] = [
    guarded(containerDirective),
    guarded(blockDirective),
    guarded(inlineDirective),
    guarded(blockDollarMath),
    guarded(blockBracketMath),
    guarded(inlineDollarMath),
    guarded(inlineParenMath),
    guarded(inlineBracketMath),
    guarded(literalCitation),
    guarded(linkShapedCitation),
  ];
  return {
    extensions,
    tokenizer: {
      del: () => undefined,
    },
  };
}
