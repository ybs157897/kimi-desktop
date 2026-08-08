/**
 * Markdown — the assistant/user text pipeline (Codex-aligned).
 *
 * Pipeline: preprocess → marked lexer (GFM + `breaks`, standard `~~del~~`
 * disabled, directive / math / citation extensions) → recursive tokens→React
 * renderer. A root ErrorBoundary with a retry button guards the whole tree,
 * and every stage degrades to raw text instead of crashing the message.
 *
 * Exports the pinned sub-components (`MarkdownCitation`, `MarkdownCodeBlock`,
 * `MarkdownMath`) that other modules consume from this file.
 */

import { Component, useMemo, useRef, useState, type ReactNode } from 'react';
import { Lexer, Marked } from 'marked';

import '../../styles/markdown.css';

import { createMarkdownExtensions } from './extensions';
import { preprocessMarkdown } from './preprocess';
import { renderTokens, type RenderContext } from './render';
import { advanceStreamState, buildStreamedSource, createInitialStreamState, type StreamState } from './streaming';
import { MarkdownCitation } from './MarkdownCitation';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import type { MarkdownCodeBlockProps } from './MarkdownCodeBlock';
import { MarkdownMath } from './MarkdownMath';
import type { MarkdownMathProps } from './MarkdownMath';

export interface MarkdownProps {
  /** Full markdown source (L1 always holds the complete text so far). */
  readonly source: string;
  /** Stream in progress: renders a trailing cursor and keeps the block live. */
  readonly streaming?: boolean;
}

// Single configured instance: GFM on, soft line breaks become <br>, standard
// `~~strikethrough~~` disabled, plus the directive / math / citation
// extensions. Lexing always uses the instance defaults (which carry the
// extension registrations) — passing a plain options object would drop them.
const markdown = new Marked({ gfm: true, breaks: true, silent: true });
markdown.use(createMarkdownExtensions());

/** Recursive lexing for directive container bodies, reusing the extensions. */
const RENDER_CONTEXT: RenderContext = {
  lexBlock: (src) => Lexer.lex(src, markdown.defaults),
  lexInline: (src) => Lexer.lexInline(src, markdown.defaults),
};

// ------------------------------------------------------------ error boundary

interface MarkdownErrorBoundaryProps {
  readonly children: ReactNode;
  /** Re-run the whole render pipeline (new lex + render pass). */
  readonly onRetry: () => void;
}

interface MarkdownErrorBoundaryState {
  readonly error: Error | null;
}

/** Root guard: a rendering failure shows a retry button, never a dead view. */
class MarkdownErrorBoundary extends Component<MarkdownErrorBoundaryProps, MarkdownErrorBoundaryState> {
  override state: MarkdownErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): MarkdownErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  private readonly handleRetry = () => {
    this.setState({ error: null });
    this.props.onRetry();
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="markdown-error" role="alert">
          <span>Markdown 渲染失败</span>
          <button type="button" onClick={this.handleRetry}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// -------------------------------------------------------------------- markdown

export function Markdown({ source, streaming = false }: MarkdownProps) {
  // `attempt` re-runs the pipeline on retry; lexing is cheap for one message.
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);

  // Chunk state for the streaming fade-in. Derived during render (React's
  // documented pattern): the delta split must happen before the markup source
  // below is built, and the transition is pure so double-invoked renders and
  // StrictMode produce the same state.
  const [stream, setStream] = useState<StreamState>(() => createInitialStreamState(source));
  if (attemptRef.current !== attempt) {
    attemptRef.current = attempt;
    setStream(createInitialStreamState(source));
  } else {
    const nextStream = advanceStreamState(stream, source, streaming);
    if (nextStream !== stream) setStream(nextStream);
  }

  const markupSource = useMemo(() => buildStreamedSource(stream), [stream]);

  const content = useMemo(() => {
    try {
      const processed = preprocessMarkdown(markupSource, streaming);
      const tokens = markdown.lexer(processed);
      return renderTokens(tokens, RENDER_CONTEXT);
    } catch {
      // Last-resort fallback: the raw source as escaped plain text.
      return source;
    }
  }, [markupSource, streaming, attempt]);

  return (
    <MarkdownErrorBoundary onRetry={() => setAttempt((n) => n + 1)}>
      <div className="markdown selectable">
        {content}
        {streaming ? <span className="markdown-cursor" aria-hidden /> : null}
      </div>
    </MarkdownErrorBoundary>
  );
}

// ------------------------------------------------------------------ exports

export type { MarkdownCodeBlockProps, MarkdownMathProps };
export { MarkdownCitation, MarkdownCodeBlock, MarkdownMath };
