/**
 * FileTreePanel — the right-dock workspace browser over `fs:list` (lazy,
 * one level at a time) + `fs:read` (selected file content).
 *
 * The tree expands directories on demand (depth: 1 per fetch, so each toggle
 * is its own query). Selecting a file reads it (utf-8 when possible; base64 /
 * binary surfaces a placeholder). File content reuses the markdown pipeline's
 * code block for highlighting via the response's `language_id`.
 */

import type { FsEntry } from '@moonshot-ai/protocol';
import { useMemo, useState } from 'react';

import { useFsList, useFsRead, useFsOpen } from '#/lib/queries';
import { MarkdownCodeBlock } from '../markdown/MarkdownCodeBlock';

export interface FileTreePanelProps {
  readonly sessionId: string;
}

export function FileTreePanel({ sessionId }: FileTreePanelProps) {
  const root = useFsList(sessionId, { path: '.', depth: 1, limit: 500 });
  const [selected, setSelected] = useState<string | null>(null);
  const read = useFsRead(sessionId, selected === null ? null : { path: selected });
  const open = useFsOpen(sessionId);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 w-[42%] min-w-[140px] max-w-[240px] shrink-0 overflow-y-auto border-r border-[var(--color-border-light)] py-1">
        {root.isLoading ? (
          <div className="px-3 py-2 text-[11px] text-[var(--gray-500)]">加载中…</div>
        ) : root.isError ? (
          <div className="px-3 py-2 text-[11px] text-[var(--red-400)]">读取目录失败</div>
        ) : (
          <ul>
            {(root.data?.items ?? []).map((entry) => (
              <TreeRow
                key={entry.path}
                sessionId={sessionId}
                entry={entry}
                depth={0}
                selected={selected}
                onSelect={setSelected}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {selected === null ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--gray-500)]">
            选择一个文件查看内容
          </div>
        ) : read.isLoading ? (
          <div className="px-4 py-3 text-[11px] text-[var(--gray-500)]">读取文件…</div>
        ) : read.isError ? (
          <div className="px-4 py-3 text-[11px] text-[var(--red-400)]">读取失败</div>
        ) : read.data?.is_binary === true || read.data?.encoding === 'base64' ? (
          <BinaryPlaceholder
            path={selected}
            size={read.data?.size}
            onOpen={() => open.mutate({ path: selected })}
          />
        ) : (
          <FileViewer
            path={selected}
            content={read.data?.content ?? ''}
            language={read.data?.language_id}
            truncated={read.data?.truncated === true}
            onOpen={() => open.mutate({ path: selected })}
          />
        )}
      </div>
    </div>
  );
}

/** One tree row: a directory (expandable, lazy) or a file (selectable). */
function TreeRow({
  sessionId,
  entry,
  depth,
  selected,
  onSelect,
}: {
  readonly sessionId: string;
  readonly entry: FsEntry;
  readonly depth: number;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = useFsList(
    sessionId,
    { path: entry.path, depth: 1, limit: 500 },
    expanded && entry.kind === 'directory',
  );
  const childEntries = useMemo(() => sortEntries(children.data?.items ?? []), [children.data]);
  const isDir = entry.kind === 'directory';
  const isSelected = selected === entry.path;

  return (
    <li>
      <button
        type="button"
        title={entry.path}
        onClick={() => {
          if (isDir) setExpanded((value) => !value);
          else onSelect(entry.path);
        }}
        className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-[11px] hover:bg-[var(--color-list-hover)] ${
          isSelected ? 'bg-[var(--color-list-hover)]' : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span aria-hidden className="w-3 shrink-0 text-[var(--gray-500)]">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span aria-hidden className="shrink-0 text-[var(--gray-500)]">
          {isDir ? '📁' : fileGlyph(entry.name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]">
          {entry.name}
        </span>
        {entry.git_status !== undefined && entry.git_status !== 'clean' ? (
          <span className="shrink-0 text-[10px] text-[var(--orange-400)]">{entry.git_status[0]?.toUpperCase()}</span>
        ) : null}
      </button>
      {expanded && isDir ? (
        <ul>
          {children.isLoading ? (
            <li className="py-0.5 text-[10px] text-[var(--gray-500)]" style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}>
              加载中…
            </li>
          ) : (
            childEntries.map((child) => (
              <TreeRow
                key={child.path}
                sessionId={sessionId}
                entry={child}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

function FileViewer({
  path,
  content,
  language,
  truncated,
  onOpen,
}: {
  readonly path: string;
  readonly content: string;
  readonly language: string | undefined;
  readonly truncated: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]" title={path}>
          {path}
        </span>
        <button
          type="button"
          onClick={onOpen}
          title="打开"
          className="shrink-0 rounded px-1.5 py-0.5 text-[var(--gray-500)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          ↗
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        <MarkdownCodeBlock code={content} language={language ?? guessLanguage(path)} />
      </div>
      {truncated ? (
        <div className="shrink-0 border-t border-[var(--color-border-light)] px-3 py-1 text-[10px] text-[var(--orange-400)]">
          文件过大，已截断
        </div>
      ) : null}
    </div>
  );
}

function BinaryPlaceholder({
  path,
  size,
  onOpen,
}: {
  readonly path: string;
  readonly size: number | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-[var(--gray-500)]">
      <span className="font-mono">{path}</span>
      <span>二进制文件{size !== undefined ? `（${formatSize(size)}）` : ''}</span>
      <button
        type="button"
        onClick={onOpen}
        className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
      >
        在文件管理器中显示
      </button>
    </div>
  );
}

function sortEntries(items: readonly FsEntry[]): FsEntry[] {
  return [...items].sort((a, b) => {
    // Directories first, then files; within a group, name-asc.
    const ad = a.kind === 'directory' ? 0 : 1;
    const bd = b.kind === 'directory' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
}

function fileGlyph(name: string): string {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)) return '🖼️';
  if (/\.(mp[34]|mov|webm|wav|ogg|flac|m4a|aac)$/i.test(name)) return '🎬';
  if (/\.(zip|tar|gz|bz2|7z|rar)$/i.test(name)) return '🗜️';
  return '📄';
}

function guessLanguage(path: string): string {
  const ext = path.split('.').at(-1) ?? '';
  return ext.toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
