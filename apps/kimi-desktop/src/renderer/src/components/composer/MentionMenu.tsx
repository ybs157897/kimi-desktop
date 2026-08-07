/**
 * MentionMenu — the floating autocomplete that appears when the Composer types
 * `@` / `$` / `/`. Rendered at the caret position captured when the menu
 * opened. The owner passes the candidate list and an `onPick` callback; arrow
 * keys + Enter navigate, Esc closes.
 */

import { useEffect, useRef, useState } from 'react';

export interface MentionCandidate {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly glyph?: string;
}

export interface MentionMenuProps {
  readonly candidates: readonly MentionCandidate[];
  readonly anchor: { readonly top: number; readonly left: number };
  readonly onPick: (candidate: MentionCandidate) => void;
  readonly onClose: () => void;
}

export function MentionMenu({ candidates, anchor, onPick, onClose }: MentionMenuProps) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Reset the active row whenever the candidate list changes.
  useEffect(() => {
    setActive(0);
  }, [candidates]);

  // Keyboard navigation: arrows move, Enter picks, Esc closes. The host stops
  // typing from reaching the editor while the menu is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((prev) => Math.min(prev + 1, candidates.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        if (candidates[active] !== undefined) {
          event.preventDefault();
          onPick(candidates[active]);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [candidates, active, onPick, onClose]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const row = list.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (candidates.length === 0) {
    return (
      <div
        className="fixed z-50 max-h-64 w-72 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] py-1 text-[11px] text-[var(--gray-500)] shadow-xl"
        style={{ top: anchor.top, left: anchor.left }}
      >
        <div className="px-3 py-1.5">无匹配项</div>
      </div>
    );
  }

  return (
    <ul
      ref={listRef}
      className="fixed z-50 max-h-64 w-72 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] py-1 shadow-xl"
      style={{ top: anchor.top, left: anchor.left }}
    >
      {candidates.map((candidate, index) => (
        <li key={candidate.value}>
          <button
            type="button"
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(candidate)}
            title={candidate.description}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
              index === active ? 'bg-[var(--color-list-hover)]' : ''
            }`}
          >
            {candidate.glyph !== undefined ? (
              <span aria-hidden className="shrink-0 text-[12px]">
                {candidate.glyph}
              </span>
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-[var(--color-text-foreground)]">
                {candidate.label}
              </span>
              {candidate.description !== undefined && candidate.description !== '' ? (
                <span className="block truncate text-[10px] text-[var(--gray-500)]">
                  {candidate.description}
                </span>
              ) : null}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
