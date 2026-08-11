import type { ToolCallFrame, TranscriptTask } from '@moonshot-ai/transcript';

import {
  projectSubagentActivity,
  summarizeSubagents,
} from '#/lib/subagentSummary';
import { SubagentGlyph } from '../../subagents/SubagentGlyph';

export function SubagentActivityRow({
  frames,
  tasks,
  onOpenAgent,
  onOpenSubagents,
}: {
  readonly frames: readonly ToolCallFrame[];
  readonly tasks?: ReadonlyMap<string, TranscriptTask>;
  readonly onOpenAgent?: (agentId: string, prompt?: string) => void;
  readonly onOpenSubagents?: () => void;
}) {
  const summary = summarizeSubagents(projectSubagentActivity(frames, tasks));
  if (summary === undefined) return null;

  return (
    <section
      role="group"
      aria-label={summary.ariaLabel}
      className="mb-3 min-w-0 max-w-[46rem] text-[length:var(--codex-chat-font-size)] leading-5 text-[var(--color-text-secondary)]"
    >
      {summary.visibleEntries.map((entry, index) => {
        const canOpen = entry.agentId !== undefined && onOpenAgent !== undefined;
        const content = (
          <>
            <SubagentGlyph seed={entry.agentId ?? entry.key} tag={entry.tag} />
            <span className="min-w-0 truncate">{entry.label}</span>
          </>
        );
        const className = `subagent-chip-enter ui-pressable mr-1.5 inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-full border border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] pl-1.5 pr-2 align-middle text-[length:var(--codex-chat-font-size)] text-[var(--color-text-secondary)] first:-ml-1.5 ${canOpen ? 'cursor-pointer hover:border-[var(--color-border)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2' : ''}`;
        if (!canOpen) {
          return (
            <span key={entry.key} className={className}>
              {content}
            </span>
          );
        }
        return (
          <button
            key={entry.key}
            type="button"
            className={className}
            aria-label={`打开 ${entry.label} 子智能体对话，${agentStateLabel(entry.state)}`}
            onClick={() => onOpenAgent(entry.agentId!, entry.prompt)}
            style={{ animationDelay: `${Math.min(index * 35, 105)}ms` }}
          >
            {content}
          </button>
        );
      })}
      {summary.overflowCount > 0 ? (
        onOpenSubagents !== undefined ? (
          <button
            type="button"
            className="ui-pressable mr-1.5 cursor-pointer align-middle text-[length:var(--codex-chat-font-size)] underline decoration-[var(--color-border-heavy)] underline-offset-2 hover:text-[var(--color-text-foreground)] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            aria-label={`查看其他 ${summary.overflowCount} 个子智能体`}
            onClick={onOpenSubagents}
          >
            及其他 {summary.overflowCount} 个子智能体
          </button>
        ) : (
          <span className="mr-1.5 align-middle">
            及其他 {summary.overflowCount} 个子智能体
          </span>
        )
      ) : null}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="relative top-px align-middle text-[length:var(--codex-chat-font-size)]"
      >
        {summary.inlineLabel}
      </span>
    </section>
  );
}

function agentStateLabel(state: TranscriptTask['state']): string {
  if (state === 'running') return '运行中';
  if (state === 'completed') return '已完成';
  if (state === 'killed') return '已终止';
  return '失败';
}
