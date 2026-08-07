/**
 * StatusBar — the Codex-style bottom status strip (TUI footer equivalent):
 * model + thinking effort on the left, git branch + context usage on the
 * right. The model rides the session record (`useSession`, events-merged by
 * the activity socket); thinking and context ride `useSessionStatus` (REST
 * baseline + `agent.status.updated` event merges + 30 s poll fallback); the
 * git branch comes from the v2 session list (`include=git`).
 */

import { useSession, useSessionStatus } from '#/lib/queries';
import { formatTokens } from '#/lib/sessionModes';

export interface StatusBarProps {
  readonly sessionId: string | null;
  /** Active session's git branch (from the v2 list with `include=git`). */
  readonly gitBranch: string | null;
}

export function StatusBar({ sessionId, gitBranch }: StatusBarProps) {
  const sessionQuery = useSession(sessionId);
  const statusQuery = useSessionStatus(sessionId);

  const model = sessionQuery.data?.agent_config.model;
  const thinking = statusQuery.data?.thinking_level;
  const status = statusQuery.data;

  let contextText: string | null = null;
  if (status !== undefined) {
    const percent = Math.round((status.context_usage ?? 0) * 100);
    const tokens = formatTokens(status.context_tokens);
    if (status.max_context_tokens !== undefined && status.max_context_tokens > 0) {
      contextText = `context: ${percent}% (${tokens} / ${formatTokens(status.max_context_tokens)})`;
    } else {
      contextText = `context: ${percent}% (${tokens})`;
    }
  }

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-[var(--color-border-light)] bg-[var(--color-background-surface-under)] px-3 text-[10px] text-[var(--color-text-tertiary)]">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {model !== undefined && model !== '' ? (
          <span className="truncate font-mono" title={model}>
            {model}
          </span>
        ) : null}
        {thinking !== undefined && thinking !== '' ? <span>thinking: {thinking}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {gitBranch !== null ? (
          <span className="flex items-center gap-1" title={`git 分支 ${gitBranch}`}>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M6 9v6M18 6a3 3 0 0 1-3 3H6" />
            </svg>
            <span className="font-mono">{gitBranch}</span>
          </span>
        ) : null}
        {contextText !== null ? <span className="font-mono">{contextText}</span> : null}
      </div>
    </footer>
  );
}
