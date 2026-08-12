/**
 * GitCommitPushPopover — the thread summary's compact entry point for writing
 * a commit message, optionally staging the working tree, and pushing commits.
 */

import {
  CaretDown,
  CircleNotch,
  CloudArrowUp,
  GitBranch,
  GitCommit,
  Sparkle,
} from '@phosphor-icons/react';
import { useIsMutating } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { friendlyGitOperationError } from '#/lib/gitPresentation';
import {
  useFsGitCommit,
  useFsGitGenerateCommitMessage,
  useFsGitPush,
  useFsGitStage,
} from '#/lib/queries';
import { useModalDialog } from '#/lib/useModalDialog';

export interface GitCommitPushPopoverProps {
  readonly sessionId: string;
  readonly branch?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly ahead: number;
  readonly stagedFileCount: number;
  readonly unstagedFileCount: number;
  readonly changedFileCount: number;
  readonly disabled?: boolean;
}

interface PopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

const POPOVER_WIDTH = 448;
const VIEWPORT_GUTTER = 8;
const ANCHOR_GAP = 6;

function CommitPushDialog({
  children,
  id,
  titleId,
  busy,
  position,
  initialFocusRef,
  onClose,
  onKeyDown,
}: {
  readonly children: ReactNode;
  readonly id: string;
  readonly titleId: string;
  readonly busy: boolean;
  readonly position: PopoverPosition;
  readonly initialFocusRef: RefObject<HTMLTextAreaElement | null>;
  readonly onClose: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose, { initialFocusRef });

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-[color-mix(in_srgb,var(--color-terminal-shell)_38%,transparent)] backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        className="fixed z-50 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--color-border-heavy)] bg-[var(--color-background-panel)] text-[14px] shadow-[var(--shadow-floating-panel)] outline-none"
        style={{
          left: position.left,
          top: position.top,
          width: position.width,
          maxHeight: position.maxHeight,
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function GitCommitPushPopover({
  sessionId,
  branch,
  additions,
  deletions,
  ahead,
  stagedFileCount,
  unstagedFileCount,
  changedFileCount,
  disabled = false,
}: GitCommitPushPopoverProps) {
  const stage = useFsGitStage(sessionId);
  const commit = useFsGitCommit(sessionId);
  const push = useFsGitPush(sessionId);
  const generate = useFsGitGenerateCommitMessage(sessionId);
  const gitMutations = useIsMutating({ mutationKey: ['git-mutation', sessionId] });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const actionRunningRef = useRef(false);
  const lifecycleEpochRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const popoverId = useId();
  const titleId = useId();
  const messageId = useId();
  const busy =
    disabled ||
    gitMutations > 0 ||
    stage.isPending ||
    commit.isPending ||
    push.isPending ||
    generate.isPending;
  const hasCommitChanges = includeUnstaged ? changedFileCount > 0 : stagedFileCount > 0;
  const canCommit = hasCommitChanges && !busy;
  const canPush = ahead > 0 && !busy;

  const updatePosition = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (anchor === undefined) return;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2);
    const maxHeight = window.innerHeight - VIEWPORT_GUTTER * 2;
    const preferredLeft = anchor.left - width - ANCHOR_GAP;
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, preferredLeft),
      window.innerWidth - width - VIEWPORT_GUTTER,
    );
    const top = Math.min(
      Math.max(VIEWPORT_GUTTER, anchor.top),
      window.innerHeight - Math.min(maxHeight, 390) - VIEWPORT_GUTTER,
    );
    setPosition({ left, top, width, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const update = (): void => updatePosition();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    lifecycleEpochRef.current += 1;
    setOpen(false);
    setMessage('');
    setIncludeUnstaged(true);
    setError(null);
    setFeedback(null);
    return () => {
      lifecycleEpochRef.current += 1;
    };
  }, [sessionId]);

  useEffect(() => {
    if (feedback === null) return;
    const timer = window.setTimeout(() => setFeedback(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const resetDraft = (): void => {
    setMessage('');
    setIncludeUnstaged(true);
    setError(null);
  };

  const close = (): void => {
    if (busy) return;
    setOpen(false);
    resetDraft();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const finish = (text: string): void => {
    setOpen(false);
    resetDraft();
    setFeedback(text);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const runCommit = async (pushAfterCommit: boolean): Promise<void> => {
    if (!canCommit || actionRunningRef.current) return;
    const lifecycleEpoch = lifecycleEpochRef.current;
    const active = (): boolean => lifecycleEpochRef.current === lifecycleEpoch;
    actionRunningRef.current = true;
    setError(null);
    let committed = false;
    try {
      let commitMessage = message.trim();
      if (commitMessage === '') {
        const generated = await generate.mutateAsync({
          include_unstaged: includeUnstaged,
        });
        if (!active()) return;
        commitMessage = generated.message;
        setMessage(commitMessage);
      }
      if (includeUnstaged) {
        await stage.mutateAsync(undefined);
        if (!active()) return;
      }
      await commit.mutateAsync(commitMessage);
      if (!active()) return;
      committed = true;
      if (pushAfterCommit) {
        await push.mutateAsync(true);
        if (!active()) return;
      }
      finish(pushAfterCommit ? '更改已提交并推送' : '更改已提交');
    } catch (value) {
      if (!active()) return;
      setError(
        committed && pushAfterCommit
          ? `提交已完成，但${friendlyGitOperationError(value, '推送')}`
          : friendlyGitOperationError(value, pushAfterCommit ? '提交并推送' : '提交'),
      );
    } finally {
      actionRunningRef.current = false;
    }
  };

  const runPush = async (): Promise<void> => {
    if (!canPush || actionRunningRef.current) return;
    const lifecycleEpoch = lifecycleEpochRef.current;
    actionRunningRef.current = true;
    setError(null);
    try {
      await push.mutateAsync(true);
      if (lifecycleEpochRef.current !== lifecycleEpoch) return;
      finish('当前分支已推送');
    } catch (value) {
      if (lifecycleEpochRef.current !== lifecycleEpoch) return;
      setError(friendlyGitOperationError(value, '推送'));
    } finally {
      actionRunningRef.current = false;
    }
  };

  const generateMessage = async (): Promise<void> => {
    if (busy || actionRunningRef.current) return;
    const lifecycleEpoch = lifecycleEpochRef.current;
    actionRunningRef.current = true;
    setError(null);
    try {
      const draft = message.trim();
      const result = await generate.mutateAsync({
        draft: draft === '' ? undefined : draft,
        include_unstaged: includeUnstaged,
      });
      if (lifecycleEpochRef.current !== lifecycleEpoch) return;
      setMessage(result.message);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (value) {
      if (lifecycleEpochRef.current !== lifecycleEpoch) return;
      setError(friendlyGitOperationError(value, message.trim() === '' ? '生成提交消息' : '润色提交消息'));
    } finally {
      actionRunningRef.current = false;
    }
  };

  const toggle = (): void => {
    if (disabled) return;
    if (open) {
      close();
      return;
    }
    setFeedback(null);
    setError(null);
    setOpen(true);
  };

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        disabled={disabled}
        title={ahead > 0 ? `提交更改或推送 ${ahead} 个提交` : '提交更改或推送当前分支'}
        onClick={toggle}
        className="ui-pressable flex h-7 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2 text-left hover:bg-[var(--color-list-hover)] disabled:opacity-50"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-text-secondary)]">
          <GitCommit size={14} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-[length:var(--client-content-font-size)] text-[var(--color-text-foreground)]">
          提交或推送
        </span>
        <span className="ml-auto flex shrink-0 items-center text-[var(--color-text-tertiary)]">
          {busy && open ? (
            <CircleNotch size={12} className="animate-spin" aria-hidden />
          ) : (
            <CaretDown size={11} aria-hidden />
          )}
        </span>
      </button>
      {feedback === null ? null : (
        <div role="status" className="px-2 py-1 text-[14px] leading-5 text-[var(--color-text-success)]">
          {feedback}
        </div>
      )}

      {open && position !== null
        ? (
            <CommitPushDialog
              id={popoverId}
              titleId={titleId}
              busy={busy}
              position={position}
              initialFocusRef={textareaRef}
              onClose={close}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) {
                  event.preventDefault();
                  void runCommit(false);
                }
              }}
            >
              <div className="flex h-14 items-center gap-2 px-5">
                <GitBranch size={15} className="shrink-0 text-[var(--color-text-secondary)]" aria-hidden />
                <h2 id={titleId} className="min-w-0 flex-1 truncate font-normal text-[var(--color-text-foreground)]">
                  {branch ?? '当前分支'}
                </h2>
                <span className="shrink-0 tabular-nums">
                  <span className="text-[var(--color-text-success)]">+{additions}</span>{' '}
                  <span className="text-[var(--color-text-danger)]">-{deletions}</span>
                </span>
              </div>

              <div className="relative h-[136px] px-5">
                <label htmlFor={messageId} className="sr-only">提交信息</label>
                <textarea
                  ref={textareaRef}
                  id={messageId}
                  value={message}
                  disabled={busy}
                  placeholder="提交信息（留空将自动生成）"
                  onChange={(event) => {
                    setMessage(event.target.value);
                    setError(null);
                  }}
                  className="h-full w-full resize-none bg-transparent py-2 pr-12 text-[14px] leading-6 text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] disabled:opacity-60"
                />
                <button
                  type="button"
                  aria-label={message.trim() === '' ? '使用 Agent 生成提交信息' : '使用 Agent 润色提交信息'}
                  title={message.trim() === '' ? '使用 Agent 生成提交信息' : '使用 Agent 润色提交信息'}
                  disabled={busy || changedFileCount === 0}
                  onClick={() => void generateMessage()}
                  className="ui-pressable absolute right-4 top-1 flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:text-[var(--color-text-tertiary)] disabled:opacity-40"
                >
                  {generate.isPending ? (
                    <CircleNotch size={17} className="animate-spin" aria-hidden />
                  ) : (
                    <Sparkle size={17} aria-hidden />
                  )}
                </button>
              </div>

              <label className="flex h-12 cursor-pointer items-center gap-2 border-b border-[var(--color-border-light)] px-5 text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)]">
                <input
                  type="checkbox"
                  checked={includeUnstaged}
                  disabled={busy}
                  onChange={(event) => {
                    setIncludeUnstaged(event.target.checked);
                    setError(null);
                  }}
                  className="h-4 w-4 shrink-0 accent-[var(--color-button-primary-background)]"
                />
                <span className="min-w-0 flex-1 font-medium">包含未暂存的更改</span>
                <span className="shrink-0 tabular-nums text-[var(--color-text-tertiary)]">
                  {includeUnstaged ? changedFileCount : stagedFileCount} 个文件
                </span>
              </label>

              {!includeUnstaged && stagedFileCount === 0 ? (
                <p className="border-b border-[var(--color-border-light)] px-5 py-2 leading-5 text-[var(--color-text-tertiary)]">
                  请先暂存至少一个文件，或包含未暂存的更改。
                </p>
              ) : null}
              {error === null ? null : (
                <p role="alert" className="border-b border-[var(--color-border-light)] px-5 py-2 leading-5 text-[var(--color-text-danger)]">
                  {error}
                </p>
              )}

              <div className="p-2">
                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={() => void runCommit(false)}
                  className="ui-pressable flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-list-hover)] px-3 text-left text-[var(--color-text-foreground)] hover:bg-[var(--color-background-button-secondary)] disabled:bg-transparent disabled:text-[var(--color-text-tertiary)] disabled:opacity-50"
                >
                  <GitCommit size={15} aria-hidden />
                  <span className="min-w-0 flex-1">{generate.isPending && message.trim() === '' ? '正在生成…' : '提交'}</span>
                  <span className="shrink-0 text-[var(--color-text-tertiary)]">⌘ ↵</span>
                </button>
                <button
                  type="button"
                  disabled={!canCommit}
                  onClick={() => void runCommit(true)}
                  className="ui-pressable flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 text-left text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:text-[var(--color-text-tertiary)] disabled:opacity-50"
                >
                  <CloudArrowUp size={15} aria-hidden />
                  <span>{stage.isPending || commit.isPending || push.isPending ? '处理中…' : '提交并推送'}</span>
                </button>
                <button
                  type="button"
                  disabled={!canPush}
                  onClick={() => void runPush()}
                  className="ui-pressable flex h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 text-left text-[var(--color-text-foreground)] hover:bg-[var(--color-list-hover)] disabled:text-[var(--color-text-tertiary)] disabled:opacity-50"
                >
                  <CloudArrowUp size={15} aria-hidden />
                  <span>推送{ahead > 0 ? `（${ahead}）` : ''}</span>
                </button>
              </div>
            </CommitPushDialog>
          )
        : null}
    </div>
  );
}
