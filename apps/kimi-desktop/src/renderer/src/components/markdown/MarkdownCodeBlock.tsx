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
import { useEffect, useId, useRef, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { LanguageRegistration, ThemeRegistrationRaw } from 'shiki/types';

import { codeBlockLanguage } from './codeBlockLanguage';

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

/** Copy button in the code block toolbar. */
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
      {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
    </button>
  );
}

function CodeWrapButton({
  wrapped,
  onClick,
}: {
  readonly wrapped: boolean;
  readonly onClick: () => void;
}) {
  const label = wrapped ? '禁用自动换行' : '启用自动换行';
  return (
    <button
      type="button"
      className="markdown-code-wrap-toggle"
      aria-label={label}
      aria-pressed={wrapped}
      title={label}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
        <path d="M2 3.5h12M2 7h9.25a2.25 2.25 0 0 1 0 4.5H9" />
        <path d="m10.5 9.75-1.75 1.75 1.75 1.75M2 11.5h4" />
      </svg>
    </button>
  );
}

/**
 * MermaidDiagram — renders a fenced `mermaid` block as SVG.
 *
 * Mermaid is imported dynamically (`import('mermaid')`) so it is code-split
 * out of the initial bundle; a failed import (e.g. blocked) degrades to a
 * plain-text code block. The theme mirrors `data-theme` the same way the main
 * component does, re-rendering when it flips.
 */
function MermaidDiagram({ code }: { readonly code: string }) {
  const reactId = useId();
  const renderId = 'mmd-' + reactId.replace(/[:]/g, '');
  const [state, setState] = useState<{ svg: string | null; error: boolean }>({ svg: null, error: false });
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
    const theme = document.documentElement.dataset['theme'] === 'light' ? 'default' : 'dark';
    void (async () => {
      try {
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default;
        mermaid.initialize({
          startOnLoad: false,
          theme,
          securityLevel: 'strict',
          fontFamily: 'var(--ui-font-family), var(--font-sans), system-ui, sans-serif',
        });
        const { svg } = await mermaid.render(renderId, code);
        if (!cancelled) setState({ svg, error: false });
      } catch {
        if (!cancelled) setState({ svg: null, error: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, renderId, themeTick]);

  if (state.svg !== null) {
    return <div className="markdown-mermaid" dir="ltr" dangerouslySetInnerHTML={{ __html: state.svg }} />;
  }
  return (
    <pre className="markdown-code-block">
      <code>{code}</code>
    </pre>
  );
}

export function MarkdownCodeBlock({ code, language, streaming = false }: MarkdownCodeBlockProps) {
  const { id: normalized, label: languageLabel } = codeBlockLanguage(language);

  if (normalized === 'mermaid') {
    return <MermaidCodeBlock code={code} />;
  }

  return (
    <HighlightedCodeBlock
      code={code}
      languageLabel={languageLabel}
      normalized={normalized}
      streaming={streaming}
    />
  );
}

function MermaidCodeBlock({ code }: { readonly code: string }) {
  return (
    <div className="markdown-code-shell" data-lang="mermaid">
      <div className="markdown-code-lang">
        <span className="markdown-code-lang-name">Mermaid</span>
      </div>
      <div className="markdown-code-body" dir="ltr">
        <MermaidDiagram code={code} />
      </div>
    </div>
  );
}

function HighlightedCodeBlock({
  code,
  languageLabel,
  normalized,
  streaming,
}: {
  readonly code: string;
  readonly languageLabel: string;
  readonly normalized: string | null;
  readonly streaming: boolean;
}) {
  const importer = normalized !== null ? LANGUAGE_IMPORTERS[normalized] : undefined;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [wrapped, setWrapped] = useState(false);
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

  const header = (
    <div className="markdown-code-lang">
      <span className="markdown-code-lang-name">{languageLabel}</span>
      <div className="markdown-code-actions">
        <CodeWrapButton
          wrapped={wrapped}
          onClick={() => {
            setWrapped((value) => !value);
          }}
        />
        <CodeCopyButton code={code} />
      </div>
    </div>
  );
  const body =
    highlighted !== null ? (
      <div className="markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
    ) : (
      <pre className="markdown-code-block">
        <code>
          {code}
          {streaming ? <span className="markdown-cursor" aria-hidden /> : null}
        </code>
      </pre>
    );
  return (
    <div
      className="markdown-code-shell"
      data-lang={normalized ?? undefined}
      data-wrap={wrapped ? 'true' : 'false'}
    >
      {header}
      <div className="markdown-code-body" dir="ltr">
        {body}
      </div>
    </div>
  );
}
