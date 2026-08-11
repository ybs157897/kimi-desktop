/**
 * ToolRunCard — a collapsed summary of a run of consecutive groupable tool
 * calls (Codex agent-activity-group parity).
 *
 * Folded: one flat activity row (a leading status icon + the localized
 * summary + a caret). Expanded: the individual {@link ToolFrame} elements
 * render in place, each still a flat activity row of its own. Live runs stay
 * folded by default and replace that single row's label as tools advance;
 * settled multi-call runs keep the same one-row summary.
 *
 * The child frames are passed in as already-built React nodes — TurnBlock
 * owns the interaction/task resolution; this card only owns the disclosure
 * chrome and the collapse/expand motion.
 */

import { CaretRight, CheckCircle, Circle, WarningCircle } from '@phosphor-icons/react';
import { useContext, useState, type ReactNode } from 'react';

import {
  resolveToolRunPresentation,
  type ToolRun,
  type ToolRunStatus,
} from '#/lib/toolRunsFromTurn';
import { CollapsibleBody } from '../CollapsibleBody';
import { TurnContext } from '../frameContext';

export interface ToolRunCardProps {
  readonly run: ToolRun;
  /** Already-built frame nodes (one per entry in `run.frames`), in order. */
  readonly children: readonly ReactNode[];
}

export function ToolRunCard({ run, children }: ToolRunCardProps) {
  const turn = useContext(TurnContext);
  const [expandedByUser, setExpandedByUser] = useState<boolean | undefined>(undefined);
  const presentation = resolveToolRunPresentation(run, turn?.state, expandedByUser);
  // A live single call uses the same replace-in-place header as a group. Once
  // it settles, its own compact ToolFrame row takes over. Multi-call runs keep
  // the group header in both states.
  return (
    <div className="ui-card-enter mb-1 max-w-[46rem]">
      {presentation.showHeader ? (
        <button
          type="button"
          onClick={() => setExpandedByUser((value) => !(value ?? false))}
          aria-expanded={presentation.detailsExpanded}
          className="ui-pressable group/activity-header -mx-1 flex min-h-8 w-[calc(100%+0.5rem)] cursor-pointer select-none items-center gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-1 text-left text-[length:var(--codex-chat-font-size)] hover:bg-[var(--color-list-hover)]"
        >
          <RunStatusIcon status={presentation.status} live={presentation.live} />
          <span
            className={`min-w-0 flex-1 truncate text-[var(--color-token-conversation-summary-leading)] group-hover/activity-header:text-[var(--color-text-foreground)] ${presentation.live ? 'ui-shimmer-text' : ''}`}
          >
            {presentation.label}
          </span>
          <Caret expanded={presentation.detailsExpanded} />
        </button>
      ) : null}
      {/* A settled single call already has exactly one compact ToolFrame row.
          Live calls and grouped calls keep those rows behind the replaceable
          activity header unless the user explicitly asks for details. */}
      {!presentation.showHeader ? (
        <div className="flex flex-col gap-[var(--conversation-grouped-item-gap,4px)]">{children}</div>
      ) : (
        <CollapsibleBody open={presentation.detailsExpanded}>
          <div className="vertical-scroll-fade-mask flex max-h-56 flex-col gap-[var(--conversation-grouped-item-gap,4px)] overflow-y-auto pl-2">
            {children}
          </div>
        </CollapsibleBody>
      )}
    </div>
  );
}

function RunStatusIcon({ status, live }: { readonly status: ToolRunStatus; readonly live: boolean }) {
  if (status === 'error') {
    return <WarningCircle size={14} className="shrink-0 text-[var(--color-text-danger)]" aria-hidden />;
  }
  if (live || status === 'running') {
    return <Circle size={14} className="ui-dot-pulse shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
  }
  return <CheckCircle size={14} className="shrink-0 text-[var(--color-text-tertiary)]" aria-hidden />;
}

function Caret({ expanded }: { readonly expanded: boolean }) {
  return (
    <CaretRight
      size={10}
      weight="bold"
      className={`shrink-0 text-[var(--color-token-conversation-body)] transition-transform duration-[var(--duration-hover)] ${
        expanded
          ? 'rotate-90 opacity-100'
          : 'opacity-0 group-hover/activity-header:opacity-100 group-focus-visible/activity-header:opacity-100 group-has-[:focus-visible]/activity-header:opacity-100'
      }`}
      aria-hidden
    />
  );
}
