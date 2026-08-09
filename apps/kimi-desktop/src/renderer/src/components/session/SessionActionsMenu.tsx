/**
 * SessionActionsMenu — the header overflow dropdown with session-level actions
 * (M7): undo (y/N confirm → transcript refresh), compact (y/N confirm),
 * fork (switches to the copy), btw side chat, and the task browser. All ride
 * the REST session-action surface (`POST ...:undo|:compact|:fork|:btw`).
 */

import { DotsThree } from '@phosphor-icons/react';
import { useState, type RefObject } from 'react';

import type { Session } from '@moonshot-ai/protocol';

import {
  useCompactSession,
  useForkSession,
  useSession,
  useStartBtw,
  useUndoSession,
} from '#/lib/queries';
import type { ChatViewHandle } from '../chat/ChatView';

export interface SessionActionsMenuProps {
  readonly sessionId: string | null;
  /** The main chat's imperative handle — undo refreshes its transcript. */
  readonly chatRef: RefObject<ChatViewHandle | null>;
  readonly onOpenTasks: () => void;
  /** Resolve with the side agent id (`agent-<N>`) to open the btw panel. */
  readonly onSideChat: (agentId: string) => void;
  /** The fork created a new session (App switches to it). */
  readonly onForked: (session: Session) => void;
}

type ConfirmKind = 'undo' | 'compact';

const itemClass =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:opacity-40';

export function SessionActionsMenu({
  sessionId,
  chatRef,
  onOpenTasks,
  onSideChat,
  onForked,
}: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);

  const sessionQuery = useSession(sessionId);
  const undo = useUndoSession(sessionId ?? '');
  const compact = useCompactSession(sessionId ?? '');
  const fork = useForkSession();
  const startBtw = useStartBtw(sessionId ?? '');

  const busy = sessionQuery.data?.busy === true || sessionId === null;
  const pending = undo.isPending || compact.isPending || fork.isPending || startBtw.isPending;
  const mutationError = undo.error ?? compact.error ?? fork.error ?? startBtw.error;

  const close = (): void => {
    setOpen(false);
    setConfirming(null);
  };

  const runUndo = (): void => {
    if (sessionId === null) return;
    undo.mutate(
      { count: 1 },
      {
        onSuccess: () => {
          close();
          // History was rewritten server-side — re-seed the transcript from
          // the REST baseline (coalesced, ops buffered meanwhile).
          chatRef.current?.refresh();
        },
      },
    );
  };

  const runCompact = (): void => {
    if (sessionId === null) return;
    compact.mutate({}, { onSuccess: () => close() });
  };

  const runFork = (): void => {
    if (sessionId === null) return;
    fork.mutate(
      { sessionId, body: {} },
      { onSuccess: (session) => onForked(session) },
    );
  };

  const runSideChat = (): void => {
    if (sessionId === null) return;
    startBtw.mutate(undefined, {
      onSuccess: ({ agent_id }) => onSideChat(agent_id),
    });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="会话操作"
        title="会话操作"
        className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onMouseDown={close} />
          <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface)] py-1 shadow-[var(--shadow-floating-panel)]">
            {confirming === 'undo' ? (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--color-text-foreground)]">
                <span className="text-[var(--color-text-secondary)]">撤销上一条？</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={runUndo}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-danger)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  确认
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(null)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || pending}
                onClick={() => setConfirming('undo')}
                title={busy ? '会话忙时不能撤销' : '从上下文移除最后一条消息'}
                className={itemClass}
              >
                撤销上一条…
              </button>
            )}
            {confirming === 'compact' ? (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--color-text-foreground)]">
                <span className="text-[var(--color-text-secondary)]">压缩上下文？</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={runCompact}
                  className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-danger)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  确认
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirming(null)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] disabled:opacity-50"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || pending}
                onClick={() => setConfirming('compact')}
                title={busy ? '会话忙时不能压缩' : '压缩上下文以释放空间'}
                className={itemClass}
              >
                压缩上下文…
              </button>
            )}
            <button
              type="button"
              disabled={sessionId === null || pending}
              onClick={runFork}
              title="复制当前会话（含上下文）"
              className={itemClass}
            >
              复制会话
            </button>
            <button
              type="button"
              disabled={sessionId === null || pending}
              onClick={runSideChat}
              title="启动一个并行问答的侧向代理"
              className={itemClass}
            >
              侧向提问…
            </button>
            <button
              type="button"
              disabled={sessionId === null}
              onClick={() => {
                close();
                onOpenTasks();
              }}
              title="浏览后台任务"
              className={itemClass}
            >
              任务…
            </button>
            {mutationError !== null ? (
              <p className="border-t border-[var(--color-border-light)] px-3 py-1.5 text-[10.5px] text-[var(--color-text-danger)]">
                {mutationError instanceof Error ? mutationError.message : '操作失败'}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
