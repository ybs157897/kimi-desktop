import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import type { SearchHit } from '#/lib/api';
import { useSearch } from '#/lib/queries';

export interface SidebarSearchProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Fired on Enter only when the current query has no search result. */
  readonly onSubmit: (query: string) => void;
  readonly placeholder?: string;
  /** Clicking a result hands its session to the shell (selects it in the list). */
  readonly onSelect?: ((sessionId: string) => void);
}

/** Imperative handle so the shell can focus the input on Cmd+K. */
export interface SidebarSearchHandle {
  focus(): void;
}

const DEBOUNCE_MS = 300;

/** Case-insensitive, per-term snippet highlight; overlapping hits merge. */
function collectRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    if (term === '') continue;
    const termLower = term.toLowerCase();
    let from = 0;
    for (;;) {
      const index = lower.indexOf(termLower, from);
      if (index === -1) break;
      ranges.push([index, index + termLower.length]);
      from = index + termLower.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }
  return merged;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = collectRanges(text, query.split(/\s+/));
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark
        key={index}
        className="rounded-[2px] bg-[var(--blue-500)] px-0.5 text-[var(--color-text-foreground)]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** Sidebar search input (`Cmd+K` target in the full shell): controlled input,
 *  300 ms debounce, `POST /api/v1/search` results in a dropdown below the
 *  field. Esc closes results before clearing the input; picking a result emits
 *  `onSelect(sessionId)`. */
export const SidebarSearch = forwardRef<SidebarSearchHandle, SidebarSearchProps>(function SidebarSearch(
  { value, onChange, onSubmit, placeholder = '搜索…', onSelect },
  ref,
) {
  const [debouncedQuery, setDebouncedQuery] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(value), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const search = useSearch(debouncedQuery);
  const results = search.data?.items ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const listboxId = useId();
  const currentQueryIsDebounced = value.trim() === debouncedQuery.trim();
  const highlightedHit = currentQueryIsDebounced ? results[highlightedIndex] : undefined;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [value]);

  useEffect(() => {
    setHighlightedIndex((current) => (current < results.length ? current : -1));
  }, [results.length]);

  useEffect(() => {
    if (highlightedIndex !== -1) {
      optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  const choose = (hit: SearchHit) => {
    setOpen(false);
    setHighlightedIndex(-1);
    onSelect?.(hit.sessionId);
    onChange('');
  };

  const moveHighlight = (direction: 1 | -1) => {
    if (!currentQueryIsDebounced || results.length === 0) return;
    setOpen(true);
    setHighlightedIndex((current) => {
      if (current === -1) return direction === 1 ? 0 : results.length - 1;
      return (current + direction + results.length) % results.length;
    });
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && value.trim() !== ''}
        aria-controls={listboxId}
        aria-activedescendant={
          highlightedHit === undefined ? undefined : `${listboxId}-option-${highlightedIndex}`
        }
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const resultToChoose =
              highlightedHit ?? (currentQueryIsDebounced ? results[0] : undefined);
            if (resultToChoose !== undefined) choose(resultToChoose);
            else onSubmit(value);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setHighlightedIndex(-1);
            if (open) setOpen(false);
            else if (value !== '') onChange('');
          }
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setHighlightedIndex(-1);
        }}
        className="w-full rounded-xl border border-transparent bg-[var(--color-background-button-secondary)] px-3 py-2 text-[13px] tracking-[var(--tracking-tight)] text-[var(--color-text-foreground)] outline-none transition-[border-color,background-color,box-shadow] duration-[var(--duration-hover)] ease placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-heavy)] focus:bg-[var(--color-background-panel)] focus:shadow-[var(--shadow-sm)]"
      />
      {open && debouncedQuery.trim() !== '' ? (
        <div
          onMouseDown={(event) => event.preventDefault()}
          className="absolute top-full right-0 left-0 z-30 mt-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-background-surface)] shadow-xl"
        >
          {!currentQueryIsDebounced || search.isLoading ? (
            <div className="px-3 py-2 text-[12px] text-[var(--gray-500)]">搜索中…</div>
          ) : search.isError ? (
            <div className="px-3 py-2 text-[12px] text-[var(--red-400)]">搜索失败</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--gray-500)]">无匹配结果</div>
          ) : (
            <ul id={listboxId} role="listbox" className="max-h-80 overflow-y-auto py-1">
              {search.data?.indexState.state === 'building' ? (
                <li className="px-3 py-1 text-[10px] text-[var(--gray-600)]">
                  索引构建中（{search.data.indexState.indexedSessions}/{search.data.indexState.totalSessions}），结果可能不完整
                </li>
              ) : null}
              {results.map((hit, index) => {
                const highlighted = index === highlightedIndex;
                return (
                  <li
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={highlighted}
                    key={`${hit.sessionId}-${hit.agentId}-${hit.time}-${index}`}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => choose(hit)}
                      className={`block w-full px-3 py-1.5 text-left hover:bg-[var(--color-list-hover)] ${highlighted ? 'bg-[var(--color-list-hover)]' : ''}`}
                    >
                      <div className="truncate text-[12px] font-medium text-[var(--color-text-foreground)]">
                        {hit.sessionTitle !== '' ? hit.sessionTitle : '（无标题会话）'}
                      </div>
                      <div className="line-clamp-2 text-[11px] leading-snug text-[var(--gray-500)]">
                        <Highlighted text={hit.snippet} query={debouncedQuery} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
});
