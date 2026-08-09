/**
 * MarkdownCitation — clickable chip for file references.
 *
 * Rendered for literal `【path†L12】` references, link-shaped `path:12`
 * references and `::codex-file-citation{…}` directives. Clicking logs the
 * citation for now (opening the file lands with the fs panel milestone).
 */

import { FileText } from '@phosphor-icons/react';

/** File-reference chip data (`【path†L12】` / `【path†L12-L40】` literals). */
export interface MarkdownCitation {
  /** File path as written in the text (`F:` prefix means percent-encoded). */
  readonly path: string;
  /** Line anchor, e.g. `L12` or `L12-L40`. */
  readonly line?: string;
  /** Optional display label overriding the raw path. */
  readonly label?: string;
}

/** Decode a possibly `F:`-prefixed (percent-encoded) citation path. */
export function decodeCitationPath(path: string): string {
  if (!path.startsWith('F:')) return path;
  const encoded = path.slice(2);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function MarkdownCitation({ citation }: { citation: MarkdownCitation }) {
  const displayPath = decodeCitationPath(citation.path);
  const label = citation.label ?? displayPath;
  const line = citation.line !== undefined ? `†${citation.line}` : undefined;
  const handleClick = () => {
    // TODO(milestone: fs panel): open the file via the fs:* REST surface.
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      title={`${displayPath}${line !== undefined ? ` ${line}` : ''}`}
      className="markdown-citation mx-0.5 inline-flex max-w-full items-center gap-1 rounded-[var(--radius-xs)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-1.5 py-0.5 align-middle text-[var(--font-size-xs)] leading-4 text-[var(--color-text-foreground)] transition-colors hover:border-[var(--color-border-heavy)] hover:bg-[var(--color-list-hover)]"
    >
      <FileText
        size={14}
        aria-hidden
        className="shrink-0 text-[var(--color-text-secondary)]"
      />
      <span className="truncate font-mono text-[var(--color-text-foreground)]">{label}</span>
      {line !== undefined ? (
        <span className="shrink-0 text-[var(--color-token-text-secondary)]">{line}</span>
      ) : null}
    </button>
  );
}
