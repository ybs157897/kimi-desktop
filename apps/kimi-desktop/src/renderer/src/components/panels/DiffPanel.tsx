/**
 * DiffPanel — the right-dock "Changes" view over `fs:git_status` + `fs:diff`.
 *
 * Lists the session workspace's changed paths (with per-file +/− badges from
 * the git status additions/deletions); selecting one fetches its unified diff
 * and renders it through the shared diff helpers. A refresh button re-polls
 * git status; "Open" reveals a path in the file manager.
 */

import type { FsGitStatusResponse } from '@moonshot-ai/protocol';
import { useMemo, useState } from 'react';

import { useFsDiff, useFsGitStatus, useFsOpen } from '#/lib/queries';
import { countChanges, diffLineTone, diffPrefix, parseUnifiedDiff } from '#/lib/diffRender';

export interface DiffPanelProps {
  readonly sessionId: string;
}

const STATUS_TONE: Record<string, string> = {
  modified: 'text-[var(--orange-400)]',
  added: 'text-[var(--green-400)]',
  deleted: 'text-[var(--red-400)]',
  renamed: 'text-[var(--blue-300)]',
  untracked: 'text-[var(--gray-300)]',
  conflicted: 'text-[var(--red-400)]',
  clean: 'text-[var(--gray-500)]',
  ignored: 'text-[var(--gray-600)]',
};

export function DiffPanel({ sessionId }: DiffPanelProps) {
  const git = useFsGitStatus(sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  const diff = useFsDiff(sessionId, selected);
  const open = useFsOpen(sessionId);

  const entries = useMemo(() => sortedEntries(git.data), [git.data]);

  if (git.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-[16rem]">
          <div className="text-[13px] font-semibold text-[var(--color-text-foreground)]">
            没有 Git 变更
          </div>
          <div className="mt-1.5 text-[12px] leading-5 text-[var(--color-text-secondary)]">
            {friendlyGitStatusError(git.error)}
          </div>
          <button
            type="button"
            onClick={() => void git.refetch()}
            className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            重新检查
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3 py-2 text-[11px]">
        <span className="font-medium text-[var(--color-text-secondary)]">
          {git.data?.branch ?? '…'}
        </span>
        {git.data !== undefined ? (
          <span className="text-[var(--gray-500)]">
            ↑{git.data.ahead} ↓{git.data.behind}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void git.refetch()}
          title="刷新"
          className="ml-auto rounded px-1.5 py-0.5 text-[var(--gray-500)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          ↻
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* changed-files list */}
        <div className="min-h-0 w-[44%] min-w-[140px] shrink-0 overflow-y-auto border-r border-[var(--color-border-light)] px-1.5 py-2">
          {git.isLoading ? (
            <div className="px-3 py-2 text-[11px] text-[var(--gray-500)]">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-[var(--gray-500)]">无变更</div>
          ) : (
            entries.map(([path, status]) => (
              <button
                key={path}
                type="button"
                title={path}
                onClick={() => setSelected(path)}
                className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11.5px] ${
                  selected === path ? 'bg-[var(--color-list-active)]' : 'hover:bg-[var(--color-list-hover)]'
                }`}
              >
                <span className={`shrink-0 font-mono ${STATUS_TONE[status] ?? ''}`}>
                  {statusAbbrev(status)}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]">
                  {basename(path)}
                </span>
              </button>
            ))
          )}
        </div>

        {/* diff viewer */}
        <div className="min-h-0 flex-1 overflow-auto">
          {selected === null ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-[11px] text-[var(--gray-500)]">
              选择一个文件查看 diff
            </div>
          ) : diff.isLoading ? (
            <div className="px-4 py-3 text-[11px] text-[var(--gray-500)]">加载 diff…</div>
          ) : diff.isError ? (
            <div className="m-3 rounded-xl bg-[var(--color-background-button-secondary)] px-3 py-3 text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {friendlyDiffError(diff.error)}
            </div>
          ) : (
            <DiffViewer
              path={selected}
              diff={diff.data?.diff ?? ''}
              truncated={diff.data?.truncated === true}
              onOpen={() => open.mutate({ path: selected, reveal: true })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function DiffViewer({
  path,
  diff,
  truncated,
  onOpen,
}: {
  readonly path: string;
  readonly diff: string;
  readonly truncated: boolean;
  readonly onOpen: () => void;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const { adds, dels } = countChanges(lines);
  if (lines.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-[var(--gray-500)]">
        <span>无文本差异（二进制文件或未跟踪）</span>
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
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]" title={path}>
          {path}
        </span>
        <span className="shrink-0 font-mono">
          <span className="text-[var(--green-400)]">+{adds}</span>{' '}
          <span className="text-[var(--red-400)]">−{dels}</span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          title="在文件管理器中显示"
          className="shrink-0 rounded px-1.5 py-0.5 text-[var(--gray-500)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          ↗
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-5">
        {lines.map((line, index) => (
          <div key={index} className={`px-3 ${diffLineTone(line.type)}`}>
            <span className="select-none opacity-50">{diffPrefix(line.type)}</span>
            {line.text}
          </div>
        ))}
      </pre>
      {truncated ? (
        <div className="shrink-0 border-t border-[var(--color-border-light)] px-3 py-1 text-[10px] text-[var(--orange-400)]">
          diff 已截断
        </div>
      ) : null}
    </div>
  );
}

function sortedEntries(data: FsGitStatusResponse | undefined): ReadonlyArray<[string, string]> {
  if (data === undefined) return [];
  return Object.entries(data.entries).sort(([a], [b]) => a.localeCompare(b));
}

function statusAbbrev(status: string): string {
  return status === 'untracked'
    ? '?'
    : status === 'modified'
      ? 'M'
      : status === 'added'
        ? 'A'
        : status === 'deleted'
          ? 'D'
          : status === 'renamed'
            ? 'R'
            : status === 'conflicted'
              ? 'C'
              : status === 'ignored'
                ? '!'
                : status.slice(0, 1).toUpperCase();
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

function friendlyDiffError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not a git repository') || message.includes('40908')) {
    return '当前目录不是 Git 仓库，因此没有可显示的变更。';
  }
  if (message.includes('path_not_found') || message.includes('40409')) {
    return '文件已经移动或删除，请刷新变更列表。';
  }
  return '暂时无法加载文件差异，请稍后重试。';
}

function friendlyGitStatusError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not a git repository') || message.includes('40908')) {
    return '当前目录不是 Git 仓库。文件浏览仍然可用，但这里不会显示变更。';
  }
  return '暂时无法读取 Git 变更，请稍后重试。';
}
