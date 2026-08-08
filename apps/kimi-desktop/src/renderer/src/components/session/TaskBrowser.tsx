/**
 * TaskBrowser — the background-task surface (M7): a modal listing the
 * session's tasks (kind / status / command / output preview), with an
 * expanded output view and cancel. Polls every 3 s while open (the web
 * client's task-clock pattern); cancel answers 40904 `{cancelled:false}` for
 * already-finished tasks, which is treated as success.
 */

import { useRef, useState } from 'react';

import type { Task, TaskStatus } from '@moonshot-ai/protocol';

import { useCancelTask, useGetTask, useTasks } from '#/lib/queries';
import { formatDuration } from '#/lib/sessionModes';
import { useModalDialog } from '#/lib/useModalDialog';

export interface TaskBrowserProps {
  readonly sessionId: string;
  readonly onClose: () => void;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const STATUS_TONES: Record<TaskStatus, string> = {
  running: 'var(--color-text-warning)',
  completed: 'var(--color-text-success)',
  failed: 'var(--color-text-danger)',
  cancelled: 'var(--color-text-secondary)',
};

const KIND_LABELS: Record<Task['kind'], string> = {
  subagent: '子代理',
  bash: '命令',
  tool: '工具',
};

/** Elapsed (running) or total (finished) duration from the task timestamps. */
function taskDuration(task: Task): string | undefined {
  const start = task.started_at !== undefined ? Date.parse(task.started_at) : NaN;
  if (!Number.isFinite(start)) return undefined;
  const end =
    task.completed_at !== undefined
      ? Date.parse(task.completed_at)
      : task.status === 'running'
        ? Date.now()
        : NaN;
  return Number.isFinite(end) ? formatDuration(Math.max(0, end - start)) : undefined;
}

export function TaskBrowser({ sessionId, onClose }: TaskBrowserProps) {
  const tasks = useTasks(sessionId);
  const cancelTask = useCancelTask(sessionId);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const detail = useGetTask(sessionId, expandedId);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);

  const items = tasks.data?.items ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="后台任务"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex w-[680px] max-h-[85vh] flex-col overflow-hidden rounded-xl border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-light)] px-4 py-2.5">
          <span className="text-[13px] font-medium text-[var(--color-text-foreground)]">后台任务</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {tasks.isLoading ? (
            <div className="px-3 py-3 text-[12px] text-[var(--gray-500)]">加载中…</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[var(--gray-500)]">没有后台任务。</div>
          ) : (
            <ul className="space-y-1">
              {items.map((task) => (
                <li key={task.id} className="rounded-lg border border-[var(--color-border-light)]">
                  <div className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: STATUS_TONES[task.status] }}
                          aria-hidden
                        />
                        <span className="truncate text-[12px] text-[var(--color-text-foreground)]">
                          {task.description}
                        </span>
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ color: STATUS_TONES[task.status], backgroundColor: 'var(--color-list-hover)' }}
                        >
                          {STATUS_LABELS[task.status]}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--gray-500)]">
                          {KIND_LABELS[task.kind]}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[10.5px] text-[var(--gray-500)]">
                        {task.kind === 'bash' && task.command !== undefined ? `$ ${task.command}` : ''}
                        {task.model !== undefined ? ` · ${task.model}` : ''}
                        {taskDuration(task) !== undefined ? ` · ${taskDuration(task)}` : ''}
                        {task.output_bytes !== undefined && task.output_bytes > 0
                          ? ` · ${task.output_bytes} B`
                          : ''}
                      </p>
                      {task.output_preview !== undefined && task.output_preview !== '' ? (
                        <pre className="mt-1 max-h-16 overflow-auto whitespace-pre-wrap text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                          {task.output_preview}
                        </pre>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        disabled={cancelTask.isPending}
                        onClick={() => setExpandedId((current) => (current === task.id ? null : task.id))}
                        className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-50"
                      >
                        {expandedId === task.id ? '收起' : '输出'}
                      </button>
                      {task.status === 'running' ? (
                        <button
                          type="button"
                          disabled={cancelTask.isPending}
                          onClick={() => cancelTask.mutate(task.id)}
                          title="取消该任务"
                          className="rounded-md px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-50"
                        >
                          取消
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {expandedId === task.id ? (
                    <div className="border-t border-[var(--color-border-light)] px-3 py-2">
                      {detail.isLoading ? (
                        <div className="text-[11px] text-[var(--gray-500)]">加载输出…</div>
                      ) : detail.data !== undefined ? (
                        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-[var(--color-text-secondary)]">
                          {detail.data.output_preview ?? '（无输出）'}
                        </pre>
                      ) : (
                        <div className="text-[11px] text-[var(--red-400)]">无法读取输出</div>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {cancelTask.isError ? (
            <p className="px-3 pt-2 text-[11px] text-[var(--red-400)]">取消失败</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end border-t border-[var(--color-border-light)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
