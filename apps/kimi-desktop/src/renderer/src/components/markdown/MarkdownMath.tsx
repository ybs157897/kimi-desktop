/**
 * MarkdownMath — block/inline math rendered with KaTeX.
 *
 * KaTeX (and its stylesheet) are loaded lazily via dynamic import, so the
 * first message containing math pays the cost, not every chat view. Rendered
 * with `throwOnError: false` / `strict: 'ignore'`; if KaTeX still throws,
 * the raw TeX source is shown instead of taking the message down.
 */

import { useEffect, useState } from 'react';

export interface MarkdownMathProps {
  readonly tex: string;
  /** Block-level (`$$…$$` / `\[…\]`) vs inline (`\(…\)`). */
  readonly block?: boolean;
}

let katexPromise: Promise<typeof import('katex')> | null = null;

function getKatex(): Promise<typeof import('katex')> {
  if (katexPromise === null) {
    katexPromise = import('katex')
      .then(async (katex) => {
        await import('katex/dist/katex.min.css');
        return katex;
      })
      .catch((error: unknown) => {
        katexPromise = null; // allow a later retry
        throw error;
      });
  }
  return katexPromise;
}

export function MarkdownMath({ tex, block = false }: MarkdownMathProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void getKatex()
      .then((katex) => {
        if (cancelled) return;
        const rendered = katex.renderToString(tex, {
          throwOnError: false,
          strict: 'ignore',
          displayMode: block,
          output: 'htmlAndMathml',
        });
        if (!cancelled) setHtml(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tex, block]);

  if (failed) {
    return <code className="markdown-math-fallback">{tex}</code>;
  }
  if (html !== null) {
    return block ? (
      <div className="markdown-math markdown-math-block" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <span className="markdown-math markdown-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  // Not yet rendered — keep the raw source visible (streaming deltas).
  return block ? (
    <div className="markdown-math markdown-math-block">{tex}</div>
  ) : (
    <span className="markdown-math markdown-math-inline">{tex}</span>
  );
}
