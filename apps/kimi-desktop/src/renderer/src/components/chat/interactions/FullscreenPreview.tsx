/**
 * FullscreenPreview — the approval card's expanded view (the TUI Ctrl-E
 * equivalent): a fullscreen overlay with a title and caller-provided content.
 * Esc or backdrop click closes it. Includes the shared {@link DiffLines}
 * renderer used for before/after and unified diff content.
 */

import { X } from '@phosphor-icons/react';
import { useRef, type ReactNode } from 'react';

import { diffLineTone, diffPrefix, type DiffLine } from '#/lib/diffRender';
import { useModalDialog } from '#/lib/useModalDialog';

export interface FullscreenPreviewProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}

export function FullscreenPreview({ title, children, onClose }: FullscreenPreviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-[var(--color-background-surface)]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
        <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-foreground)]">
          {title}
        </span>
        <button
          type="button"
          aria-label="关闭预览"
          onClick={onClose}
          className="rounded-md p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          <X size={16} weight="bold" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
    </div>
  );
}

/** One normalized diff line with the shared tone/prefix classes. */
export function DiffLines({ lines }: { readonly lines: readonly DiffLine[] }) {
  return (
    <pre className="text-[12px] leading-[1.6]">
      {lines.map((line, index) => (
        <div key={index} className={`whitespace-pre-wrap ${diffLineTone(line.type)}`}>
          <span className="mr-2 inline-block w-4 select-none text-center opacity-60">
            {diffPrefix(line.type)}
          </span>
          {line.text}
        </div>
      ))}
    </pre>
  );
}
