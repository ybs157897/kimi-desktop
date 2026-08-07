/**
 * TodoPanel — the model's TodoList tool rendered as a live strip above the
 * composer (the TUI TodoPanelComponent position). Data comes straight from
 * the transcript store's `todos` map (`todo.upsert` ops keep it current; REST
 * pages replace it wholesale) — no op parsing here. More than 5 items
 * collapse into a summary with an expand toggle.
 */

import { useState } from 'react';

import type { TranscriptTodo } from '@moonshot-ai/transcript';

export interface TodoPanelProps {
  readonly todos: ReadonlyMap<string, TranscriptTodo>;
}

const COLLAPSE_AFTER = 5;

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-[var(--gray-600)]',
  in_progress: 'bg-[var(--blue-400)]',
  done: 'bg-[var(--green-400)]',
};

export function TodoPanel({ todos }: TodoPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const items = Array.from(todos.values()).flatMap((doc) => doc.items);
  if (items.length === 0) return null;

  const collapsed = !expanded && items.length > COLLAPSE_AFTER;
  const visible = collapsed ? items.slice(0, COLLAPSE_AFTER) : items;
  const counts = {
    inProgress: items.filter((item) => item.status === 'in_progress').length,
    done: items.filter((item) => item.status === 'done').length,
    pending: items.filter((item) => item.status === 'pending').length,
  };

  return (
    <div className="mx-auto w-full max-w-[46rem] px-5 pb-1">
      <div className="rounded-xl border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
            Todo
          </span>
          {collapsed ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-[10.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-foreground)]"
            >
              … +{items.length - COLLAPSE_AFTER} 条（{counts.inProgress} 进行中 · {counts.done} 完成）
            </button>
          ) : items.length > COLLAPSE_AFTER ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-[10.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-foreground)]"
            >
              收起
            </button>
          ) : null}
        </div>
        <ul className="space-y-0.5">
          {visible.map((item, index) => (
            <li key={index} className="flex items-center gap-2 text-[11px]">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[item.status] ?? 'bg-[var(--gray-600)]'}`}
                aria-hidden
              />
              <span
                className={
                  item.status === 'done'
                    ? 'text-[var(--color-text-tertiary)] line-through'
                    : 'text-[var(--color-text-foreground)]'
                }
              >
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
