/**
 * End-of-turn "edited files" summary (Zed-style): once a turn reaches a
 * terminal state, the files its Edit/Write calls touched are listed below
 * the assistant's final text with per-file and total +/− counts. Rows
 * expand inline to the diff lines; long lists collapse behind a
 * "再显示 M 个文件" row. Purely presentational — derived from the turn's
 * tool frames by {@link editedFilesFromTurn}, no backend involvement.
 */

import type { TranscriptTurn } from '@moonshot-ai/transcript';
import { CaretDown, CaretRight, CaretUp, Files } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';

import { diffLineTone, diffPrefix } from '#/lib/diffRender';
import { editedFilesFromTurn, type EditedFileEntry } from '#/lib/editedFiles';

import { TOOL_CARD } from './frames/ToolFrame';

/** Files listed before the "show M more" expander. */
const PREVIEW_COUNT = 3;

export function EditedFilesCard({ turn }: { readonly turn: TranscriptTurn }) {
  const entries = useMemo(() => editedFilesFromTurn(turn), [turn]);
  const [showAll, setShowAll] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());
  if (turn.state !== 'completed' && turn.state !== 'failed' && turn.state !== 'cancelled') {
    return null;
  }
  if (entries.length === 0) return null;

  const totalAdds = entries.reduce((sum, entry) => sum + entry.adds, 0);
  const totalDels = entries.reduce((sum, entry) => sum + entry.dels, 0);
  const visible = showAll ? entries : entries.slice(0, PREVIEW_COUNT);
  const hidden = entries.length - visible.length;

  const toggleFile = (path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className={TOOL_CARD}>
      <div className="flex min-h-9 items-center gap-1.5 px-2.5 py-1">
        <Files size={14} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
        <span className="min-w-0 flex-1 text-[12px] font-medium text-[var(--color-text-foreground)]">
          已编辑 {entries.length} 个文件
        </span>
        <ChangePills adds={totalAdds} dels={totalDels} />
      </div>
      <div className="border-t border-[var(--color-border-light)]">
        {visible.map((entry) => (
          <FileRow
            key={entry.path}
            entry={entry}
            expanded={expandedPaths.has(entry.path)}
            onToggle={() => toggleFile(entry.path)}
          />
        ))}
        {entries.length > PREVIEW_COUNT ? (
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
            className="ui-pressable flex min-h-8 w-full cursor-pointer select-none items-center gap-1.5 border-t border-[var(--color-border-light)] px-2.5 py-1 text-left text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
          >
            {showAll ? (
              <CaretUp size={11} weight="bold" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
            ) : (
              <CaretDown size={11} weight="bold" className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />
            )}
            {showAll ? '收起文件列表' : `再显示 ${hidden} 个文件`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FileRow({
  entry,
  expanded,
  onToggle,
}: {
  readonly entry: EditedFileEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { dir, base } = splitPath(entry.path);
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="ui-pressable flex min-h-8 w-full cursor-pointer select-none items-center gap-1.5 px-2.5 py-1 text-left hover:bg-[var(--color-list-hover)]"
      >
        <CaretRight
          size={11}
          weight="bold"
          className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${
            expanded ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
        <span className="flex min-w-0 flex-1 items-baseline font-mono text-[12px] tracking-[var(--tracking-tight)]">
          <span className="truncate text-[var(--color-text-tertiary)]">{dir}</span>
          <span className="shrink-0 truncate text-[var(--color-text-foreground)]">{base}</span>
        </span>
        <ChangePills adds={entry.adds} dels={entry.dels} />
      </button>
      {expanded ? (
        <pre className="max-h-72 overflow-auto border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] py-1.5 font-mono text-[11.5px] leading-[1.55]">
          {entry.segments.map((segment, segmentIndex) => (
            <div key={segmentIndex}>
              {segmentIndex > 0 ? (
                <div className="mx-3.5 my-1 border-t border-dashed border-[var(--color-border-light)]" />
              ) : null}
              {segment.map((line, lineIndex) => (
                <div key={lineIndex} className={`px-3.5 ${diffLineTone(line.type)}`}>
                  <span className="select-none opacity-50">{diffPrefix(line.type)}</span>
                  {line.text}
                </div>
              ))}
            </div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

/** Green/red +adds/−dels pill pair, same treatment as the tool diff card. */
function ChangePills({ adds, dels }: { readonly adds: number; readonly dels: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
      <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)] px-1.5 py-0.5 text-[var(--color-text-success)]">
        +{adds}
      </span>
      <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)] px-1.5 py-0.5 text-[var(--color-text-danger)]">
        −{dels}
      </span>
    </span>
  );
}

/** Split a path into a dimmed directory prefix and the file name. */
function splitPath(path: string): { dir: string; base: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (index < 0) return { dir: '', base: path };
  return { dir: path.slice(0, index + 1), base: path.slice(index + 1) };
}
