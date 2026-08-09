/**
 * MarkdownCodeBlock — fenced code with Shiki highlighting.
 *
 * Shiki is loaded lazily and fine-grained: only `shiki/core`, the oniguruma
 * engine, the two GitHub themes and the specific grammar for the block's
 * language are ever imported (no `shiki` full bundle). Highlighting failures
 * degrade to a plain-text code block, and unknown languages (including
 * `mermaid`, whose rendering lands in a later milestone) render unhighlighted.
 *
 * The theme follows `document.documentElement[data-theme]` (`light` →
 * github-light, anything else → github-dark); the shell owns the attribute.
 * A MutationObserver re-highlights visible blocks when the attribute flips,
 * so a code block never keeps the previous theme's token colors.
 */

import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { LanguageRegistration, ThemeRegistrationRaw } from 'shiki/types';

export interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language?: string;
  /** Stream in progress: renders a trailing cursor inside the block. */
  readonly streaming?: boolean;
}

type ThemeName = 'github-light' | 'github-dark';

/** Lazily-loaded grammars — the common-language subset (see design doc). */
const LANGUAGE_IMPORTERS: Readonly<Record<string, () => Promise<{ readonly default: LanguageRegistration[] }>>> = {
  js: () => import('shiki/langs/javascript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  ts: () => import('shiki/langs/typescript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  postcss: () => import('shiki/langs/postcss.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  svg: () => import('shiki/langs/xml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  md: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  yml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  py: () => import('shiki/langs/python.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  sh: () => import('shiki/langs/shellscript.mjs'),
  shell: () => import('shiki/langs/shellscript.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  zsh: () => import('shiki/langs/zsh.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  rs: () => import('shiki/langs/rust.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  'c++': () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  'c#': () => import('shiki/langs/csharp.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  kt: () => import('shiki/langs/kotlin.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rb: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  make: () => import('shiki/langs/makefile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  ps1: () => import('shiki/langs/powershell.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  tex: () => import('shiki/langs/latex.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  wasm: () => import('shiki/langs/wasm.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  'shell session': () => import('shiki/langs/shellsession.mjs'),
};

/**
 * Normalize the fence language: strip meta (`ts {1-3}` → `ts`), lowercase.
 * Returns `null` when the block should render unhighlighted (`mermaid` and
 * other unknown languages).
 */
function normalizeLanguage(language: string | undefined): string | null {
  const raw = language?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (raw === '' || raw === 'text' || raw === 'plaintext' || raw === 'txt' || raw === 'mermaid') {
    return null;
  }
  return raw;
}

function currentTheme(): ThemeName {
  return document.documentElement.dataset['theme'] === 'light' ? 'github-light' : 'github-dark';
}

// ------------------------------------------------------------------ shiki

let highlighterPromise: Promise<HighlighterCore> | null = null;

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }, light, dark] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma'),
    import('shiki/themes/github-light.mjs'),
    import('shiki/themes/github-dark.mjs'),
  ]);
  const themes: (Promise<{ readonly default: ThemeRegistrationRaw }> | { readonly default: ThemeRegistrationRaw })[] = [light, dark];
  return createHighlighterCore({
    themes,
    langs: [],
    engine: createOnigurumaEngine(import('shiki/wasm').then((m) => m.default)),
  });
}

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighter().catch((error: unknown) => {
      highlighterPromise = null; // allow a later retry
      throw error;
    });
  }
  return highlighterPromise;
}

async function highlightCode(code: string, lang: string, importer: () => Promise<{ readonly default: LanguageRegistration[] }>): Promise<string> {
  const highlighter = await getHighlighter();
  await highlighter.loadLanguage(importer());
  return highlighter.codeToHtml(code, { lang, theme: currentTheme() });
}

// ----------------------------------------------------------------- component

/** Best-effort clipboard write; degrades to the legacy textarea trick. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall back for environments without the async clipboard API.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy button — floats over the code block header, revealed on hover/focus. */
function CodeCopyButton({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  const handleCopy = (): void => {
    void copyToClipboard(code).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };

  const label = copied ? '已复制' : '复制代码';
  return (
    <button
      type="button"
      className={`markdown-code-copy${copied ? ' is-copied' : ''}`}
      aria-label={label}
      title={label}
      onClick={handleCopy}
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
  );
}

/** Line budget over which a block folds to a preview window. */
const FOLD_THRESHOLD = 20;

export function MarkdownCodeBlock({ code, language, streaming = false }: MarkdownCodeBlockProps) {
  const normalized = normalizeLanguage(language);
  const importer = normalized !== null ? LANGUAGE_IMPORTERS[normalized] : undefined;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // Theme switches flip `data-theme` on <html> without re-rendering React, so
  // an effect dep alone would leave visible blocks stuck on the previous
  // theme's token colors. A MutationObserver bumps this counter and the
  // highlight effect re-runs with `currentTheme()`'s new theme.
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    if (normalized === null || importer === undefined) return;
    void highlightCode(code, normalized, importer)
      .then((html) => {
        if (!cancelled) setHighlighted(html);
      })
      .catch(() => {
        // Highlighting failed — keep the plain-text block.
        if (!cancelled) setHighlighted(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, importer, normalized, themeTick]);

  // Long-block fold. A streaming block stays open so the user can watch it
  // land; settled blocks over the line budget start folded.
  const lineCount = code === '' ? 0 : code.split('\n').length;
  const foldable = !streaming && lineCount > FOLD_THRESHOLD;
  const [expanded, setExpanded] = useState(!foldable);
  // Re-evaluate when `code` changes (a streaming block that crosses the
  // threshold mid-flight should not fold until it settles).
  const effectiveExpanded = streaming ? true : expanded;
  const folded = foldable && !effectiveExpanded;
  const showLines = effectiveExpanded && highlighted === null;

  const header =
    normalized !== null ? (
      <div className="markdown-code-lang">
        <span className="markdown-code-lang-dot" aria-hidden />
        <span>{normalized}</span>
      </div>
    ) : null;
  const body =
    highlighted !== null ? (
      <div className="markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
    ) : (
      <pre className="markdown-code-block">
        <code>
          {showLines
            ? code.split('\n').map((line, index) => (
                <span key={index} className="markdown-code-line">
                  {line}
                  {index < lineCount - 1 ? '\n' : ''}
                </span>
              ))
            : code}
          {streaming ? <span className="markdown-cursor" aria-hidden /> : null}
        </code>
      </pre>
    );
  return (
    <div
      className="markdown-code-shell"
      data-lang={normalized ?? undefined}
      data-folded={folded ? 'true' : 'false'}
      data-lines={showLines ? 'true' : 'false'}
    >
      {header}
      <div className="markdown-code-body">{body}</div>
      {folded ? null : <CodeCopyButton code={code} />}
      {folded ? (
        <button
          type="button"
          className="markdown-code-fold-toggle"
          onClick={() => setExpanded(true)}
        >
          展开全部 {lineCount} 行
        </button>
      ) : foldable ? (
        <button
          type="button"
          className="markdown-code-fold-toggle"
          onClick={() => setExpanded(false)}
        >
          收起
        </button>
      ) : null}
    </div>
  );
}
