/**
 * SideChatPanel — the btw side-channel surface (M7): a right-side panel
 * inside the main area hosting a full second {@link ChatView} for the side
 * agent (`agent-<N>` from `POST ...:btw`). Closing the panel leaves the
 * agent alive — same as the web client's side chat.
 */

import { ChatView } from '../chat/ChatView';

export interface SideChatPanelProps {
  readonly sessionId: string;
  /** The side agent id returned by `POST ...:btw`. */
  readonly agentId: string;
  readonly onClose: () => void;
}

export function SideChatPanel({ sessionId, agentId, onClose }: SideChatPanelProps) {
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-[var(--color-border-light)] bg-[var(--color-background-surface)]">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3">
        <span className="text-[11px] font-semibold text-[var(--color-text-foreground)]">侧向问答</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--gray-500)]" title={agentId}>
          {agentId}
        </span>
        <button
          type="button"
          aria-label="关闭侧向问答"
          title="关闭（侧向代理保持运行）"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          ✕
        </button>
      </div>
      <ChatView sessionId={sessionId} agentId={agentId} />
    </aside>
  );
}
