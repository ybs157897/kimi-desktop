/**
 * TaskRefCard — the timeline entry for a background-task receipt (`taskref`
 * items: a detached shell finishing, a backgrounded subagent completing).
 * Follows the tool-card visual contract (rounded card, tag pill, state badge,
 * collapsed by default) instead of dumping the raw output tail inline:
 * subagent results render through the markdown pipeline, shell tails stay
 * monospace, and a subagent's transcript opens via the side panel.
 */

import type { TranscriptTask, TranscriptTaskRef } from '@moonshot-ai/transcript';
import { ArrowSquareOut, CaretRight, Robot, TerminalWindow, Wrench } from '@phosphor-icons/react';
import { useState } from 'react';

import { agentTypeTag, tagClasses, tagIconClass, type TagKind } from '#/lib/agentColors';
import { Markdown } from '../../markdown/Markdown';

export interface TaskRefCardProps {
  readonly item: TranscriptTaskRef;
  readonly task?: TranscriptTask;
  /** Open a child agent's transcript in the side panel. */
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
}

const TASK_STATE_LABEL: Record<TranscriptTask['state'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  timed_out: '超时',
  killed: '已终止',
  lost: '丢失',
};

export function TaskRefCard({ item, task, onOpenAgent }: TaskRefCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (task === undefined) {
    return (
      <div className="mb-2 flex min-h-9 max-w-[46rem] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <Wrench size={14} aria-hidden />
        后台任务 {item.taskId}
      </div>
    );
  }

  const isAgent = task.kind === 'subagent';
  const typeTag = isAgent ? agentTypeTag(task.description ?? task.agentId) : undefined;
  const tag: TagKind = typeTag?.tag ?? (task.kind === 'shell' ? 'shell' : 'generic');
  const body = taskBody(task);
  const hasBody = body !== undefined && body.trim() !== '';
  const bodyLineCount = hasBody ? body.split('\n').length : 0;

  return (
    <div className="ui-card-enter mb-2 max-w-[46rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-background-panel)]">
      <div className="flex min-h-9 w-full items-center hover:bg-[var(--color-list-hover)]">
        <button
          type="button"
          onClick={() => hasBody && setExpanded((value) => !value)}
          aria-expanded={expanded}
          disabled={!hasBody}
          className="ui-pressable flex min-w-0 flex-1 select-none items-center gap-1.5 px-2.5 py-1 text-left enabled:cursor-pointer"
        >
          <CaretRight
            size={11}
            weight="bold"
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform duration-[var(--duration-hover)] ease-[var(--ease-out)] ${
              expanded ? 'rotate-90' : ''
            } ${hasBody ? '' : 'opacity-0'}`}
            aria-hidden
          />
          <span className={`shrink-0 ${tagIconClass(tag)}`} aria-hidden>
            {isAgent ? <Robot size={14} /> : <TerminalWindow size={14} />}
          </span>
          <span className={`ui-tag-pill shrink-0 ${tagClasses(tag)}`}>
            {typeTag?.label ?? (task.kind === 'shell' ? '后台命令' : task.kind)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-foreground)]">
            {task.description ?? item.taskId}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {task.detached ? (
              <span className="rounded-full bg-[var(--color-background-button-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                后台
              </span>
            ) : null}
            <TaskStatePill state={task.state} />
          </span>
        </button>
        {isAgent && task.agentId !== undefined && onOpenAgent !== undefined ? (
          <button
            type="button"
            title="打开子智能体的完整会话"
            aria-label="打开子智能体的完整会话"
            onClick={() => onOpenAgent(task.agentId!, task.description)}
            className="ui-pressable mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-button-secondary)] hover:text-[var(--color-text-foreground)]"
          >
            <ArrowSquareOut size={12} weight="regular" aria-hidden />
          </button>
        ) : null}
      </div>
      {hasBody && !expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`展开任务输出，共 ${bodyLineCount} 行`}
          className="ui-pressable flex w-full items-center gap-1.5 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-1.5 text-left text-[10.5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-secondary)]"
        >
          <CaretRight size={10} weight="bold" aria-hidden />
          <span className="truncate">{isAgent ? '查看结果' : `输出 ${bodyLineCount} 行`}</span>
        </button>
      ) : null}
      {hasBody && expanded ? (
        <>
          {task.error !== undefined && task.error !== '' ? (
            <div className="border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 pt-2 text-[11px] text-[var(--color-text-danger)]">
              {task.error}
            </div>
          ) : null}
          {isAgent ? (
            <div className="max-h-96 overflow-auto border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3.5 py-2.5 text-[12px] leading-[var(--leading-chat)]">
              <Markdown source={body} />
            </div>
          ) : (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 py-2 font-mono text-[11px] leading-[1.55] text-[var(--color-text-secondary)]">
              {body}
            </pre>
          )}
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="收起任务输出"
            className="ui-pressable flex w-full items-center justify-center gap-1 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] py-1 text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          >
            <CaretRight size={10} weight="bold" className="-rotate-90" aria-hidden />
            收起
          </button>
        </>
      ) : null}
    </div>
  );
}

function TaskStatePill({ state }: { readonly state: TranscriptTask['state'] }) {
  const tone =
    state === 'running'
      ? 'text-[var(--color-text-warning)] bg-[color-mix(in_srgb,var(--color-text-warning)_12%,transparent)]'
      : state === 'completed'
        ? 'text-[var(--color-text-success)] bg-[color-mix(in_srgb,var(--color-text-success)_12%,transparent)]'
        : state === 'killed'
          ? 'text-[var(--color-text-tertiary)] bg-[var(--color-background-button-secondary)]'
          : 'text-[var(--color-text-danger)] bg-[color-mix(in_srgb,var(--color-text-danger)_12%,transparent)]';
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {TASK_STATE_LABEL[state] ?? state}
    </span>
  );
}

/** The receipt's body: a subagent's result summary (falling back to the
 *  output tail), or a shell task's captured tail. */
function taskBody(task: TranscriptTask): string | undefined {
  if (task.kind === 'subagent') {
    if (task.resultSummary !== undefined && task.resultSummary.trim() !== '') return task.resultSummary;
    if (task.outputTail !== '') return task.outputTail;
    return undefined;
  }
  return task.outputTail !== '' ? task.outputTail : undefined;
}
