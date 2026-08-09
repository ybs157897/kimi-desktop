/**
 * Todo data helpers — the strip above the composer was removed when the
 * execution-progress list moved into the right-dock plan panel (`进程`
 * section). What remains are the shared pure helpers: `selectVisibleTodos`
 * (the collapsed-window policy) for the panel, and `todosFromTimeline`, the
 * point-in-time fallback reconstruction for transcripts whose global
 * `todo.upsert` entities are missing.
 */

import type { TodoItem, TranscriptItem, TranscriptTodo } from '@moonshot-ai/transcript';

export const COLLAPSE_AFTER = 5;

/** Keep the important states visible in the collapsed strip, matching the
 * TUI policy: every active item, then the earliest pending work, then the
 * most recently completed work. Original order is restored for display. */
export function selectVisibleTodos(items: readonly TodoItem[]): readonly TodoItem[] {
  const selected = new Set<TodoItem>();
  for (const item of items) if (item.status === 'in_progress') selected.add(item);
  for (const item of items) {
    if (selected.size >= COLLAPSE_AFTER) break;
    if (item.status === 'pending') selected.add(item);
  }
  for (let index = items.length - 1; index >= 0 && selected.size < COLLAPSE_AFTER; index -= 1) {
    const item = items[index]!;
    if (item.status === 'done') selected.add(item);
  }
  return items.filter((item) => selected.has(item));
}

/** Older transcripts may contain TodoList frames but no `todo.upsert` global
 * entity. Reconstruct the latest point-in-time snapshot for the panel. */
export function todosFromTimeline(items: readonly TranscriptItem[]): ReadonlyMap<string, TranscriptTodo> {
  let latest: readonly TodoItem[] | undefined;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind !== 'tool' || frame.name !== 'TodoList') continue;
        const display = isTodoDisplay(frame.display) ? frame.display.items : undefined;
        const input = isRecord(frame.input) && Array.isArray(frame.input['todos']) ? frame.input['todos'] : undefined;
        const source = display ?? input;
        if (source === undefined) continue;
        latest = source.map(normalizeTodo).filter(isTodoItem);
      }
    }
  }
  if (latest === undefined) return new Map();
  return new Map([['timeline-todo', { todoId: 'timeline-todo', items: latest }]]);
}

function isTodoDisplay(value: unknown): value is { kind: 'todo_list'; items: readonly unknown[] } {
  return isRecord(value) && value['kind'] === 'todo_list' && Array.isArray(value['items']);
}

function normalizeTodo(value: unknown): TodoItem | undefined {
  if (!isRecord(value) || typeof value['title'] !== 'string') return undefined;
  const status = value['status'];
  if (status !== 'pending' && status !== 'in_progress' && status !== 'done') return undefined;
  return { title: value['title'], status };
}

function isTodoItem(value: TodoItem | undefined): value is TodoItem {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
