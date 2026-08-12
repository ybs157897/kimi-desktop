/**
 * The right-dock Git workspace: branch operations, sync, staging, commit, and
 * a unified diff preview. All mutations stay session-scoped through kap-server.
 */

import {
  ArrowClockwise,
  ArrowUpRight,
  DownloadSimple,
  GitCommit,
  Minus,
  Plus,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useIsMutating } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { countChanges, diffLineTone, diffPrefix, parseUnifiedDiff } from '#/lib/diffRender';
import {
  canDiscardGitChange,
  friendlyGitOperationError,
  gitChangeGroups,
  gitChangeKey,
  gitDiscardCopy,
  type GitChangeItem,
} from '#/lib/gitPresentation';
import {
  useFsDiff,
  useFsGitBranches,
  useFsGitCommit,
  useFsGitDiscard,
  useFsGitPull,
  useFsGitPush,
  useFsGitStage,
  useFsGitStatus,
  useFsGitUnstage,
  useFsOpen,
} from '#/lib/queries';
import { useModalDialog } from '#/lib/useModalDialog';
import { GitBranchPicker } from '../git/GitBranchPicker';

export interface DiffPanelProps {
  readonly sessionId: string;
}

interface Notice {
  readonly tone: 'success' | 'error';
  readonly text: string;
}

const STATUS_TONE: Record<string, string> = {
  modified: 'text-[var(--color-text-warning)]',
  added: 'text-[var(--color-text-success)]',
  deleted: 'text-[var(--color-text-danger)]',
  renamed: 'text-[var(--color-text-accent)]',
  untracked: 'text-[var(--color-text-secondary)]',
  conflicted: 'text-[var(--color-text-danger)]',
  clean: 'text-[var(--color-text-tertiary)]',
  ignored: 'text-[var(--color-text-tertiary)]',
};

export function DiffPanel({ sessionId }: DiffPanelProps) {
  const git = useFsGitStatus(sessionId);
  const branches = useFsGitBranches(sessionId);
  const stage = useFsGitStage(sessionId);
  const unstage = useFsGitUnstage(sessionId);
  const discard = useFsGitDiscard(sessionId);
  const commit = useFsGitCommit(sessionId);
  const pull = useFsGitPull(sessionId);
  const push = useFsGitPush(sessionId);
  const open = useFsOpen(sessionId);
  const [selected, setSelected] = useState<GitChangeItem | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [discardDraft, setDiscardDraft] = useState<readonly GitChangeItem[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const actionRunningRef = useRef(false);
  const gitMutations = useIsMutating({ mutationKey: ['git-mutation', sessionId] });
  const groups = useMemo(() => gitChangeGroups(git.data), [git.data]);
  const diff = useFsDiff(sessionId, selected?.path ?? null, selected?.cohort ?? 'all');
  const branch = git.data?.branch ?? branches.data?.current;
  const changedFileCount = new Set(
    [...groups.staged, ...groups.unstaged].map((change) => change.path),
  ).size;
  const busy =
    gitMutations > 0 ||
    stage.isPending ||
    unstage.isPending ||
    discard.isPending ||
    commit.isPending ||
    pull.isPending ||
    push.isPending;

  useEffect(() => {
    if (selected === null) return;
    const stillPresent = [...groups.staged, ...groups.unstaged].some(
      (change) => gitChangeKey(change) === gitChangeKey(selected),
    );
    if (!stillPresent) setSelected(null);
  }, [groups.staged, groups.unstaged, selected]);

  const runAction = async (
    action: string,
    operation: () => Promise<unknown>,
    successText: string,
    afterSuccess?: () => void,
  ): Promise<boolean> => {
    if (actionRunningRef.current) return false;
    actionRunningRef.current = true;
    setNotice(null);
    try {
      await operation();
      afterSuccess?.();
      setNotice({ tone: 'success', text: successText });
      return true;
    } catch (error) {
      setNotice({ tone: 'error', text: friendlyGitOperationError(error, action) });
      return false;
    } finally {
      actionRunningRef.current = false;
    }
  };

  if (git.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
        <div className="max-w-[18rem]">
          <div className="text-[14px] font-semibold text-[var(--color-text-foreground)]">没有 Git 变更</div>
          <div className="mt-2 text-[14px] leading-6 text-[var(--color-text-secondary)]">
            {friendlyGitStatusError(git.error)}
          </div>
          <button
            type="button"
            onClick={() => void git.refetch()}
            className="ui-pressable mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-[14px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
          >
            重新检查
          </button>
        </div>
      </div>
    );
  }

  const discardableChanges = groups.unstaged.filter(canDiscardGitChange);
  const commitReady = commitMessage.trim() !== '' && groups.staged.length > 0 && !busy;

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[14px]">
      <div className="shrink-0 border-b border-[var(--color-border-light)] px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <GitBranchPicker
            sessionId={sessionId}
            currentBranch={branch}
            changedFileCount={changedFileCount}
            stagedFileCount={groups.staged.length}
            disabled={busy}
            className="flex-1"
            onBranchChanged={() => setSelected(null)}
            onSuccess={(text) => setNotice({ tone: 'success', text })}
            onError={(text) => setNotice({ tone: 'error', text })}
          />
          <ToolbarButton
            label="拉取远端更改"
            disabled={busy}
            onClick={() => void runAction('拉取', () => pull.mutateAsync(false), '拉取完成')}
          >
            <DownloadSimple size={16} aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="推送当前分支"
            disabled={busy}
            onClick={() => void runAction('推送', () => push.mutateAsync(true), '推送完成')}
          >
            <UploadSimple size={16} aria-hidden />
          </ToolbarButton>
          <ToolbarButton
            label="刷新 Git 状态"
            disabled={busy || git.isFetching}
            onClick={() => {
              void git.refetch();
              void branches.refetch();
            }}
          >
            <ArrowClockwise size={16} className={git.isFetching ? 'animate-spin' : ''} aria-hidden />
          </ToolbarButton>
        </div>

        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const message = commitMessage.trim();
            if (!commitReady) return;
            void runAction(
              '提交',
              () => commit.mutateAsync(message),
              '提交已创建',
              () => setCommitMessage(''),
            );
          }}
        >
          <input
            aria-label="提交消息"
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder={groups.staged.length === 0 ? '请先暂存更改' : '提交消息'}
            className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-background-surface-under)] px-2.5 text-[14px] text-[var(--color-text-foreground)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
          />
          <button
            type="submit"
            disabled={!commitReady}
            className="ui-pressable flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-button-primary-background)] px-3 font-medium text-[var(--color-button-primary-foreground)] disabled:opacity-40"
          >
            <GitCommit size={16} aria-hidden />
            {commit.isPending ? '提交中…' : '提交'}
          </button>
        </form>

        {notice !== null ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`mt-2 rounded-[var(--radius-sm)] bg-[var(--color-background-surface-under)] px-2.5 py-1.5 leading-5 ${
              notice.tone === 'error'
                ? 'text-[var(--color-text-danger)]'
                : 'text-[var(--color-text-success)]'
            }`}
          >
            {notice.text}
          </div>
        ) : null}
      </div>

      <div className="max-h-[42%] min-h-[168px] shrink-0 overflow-y-auto border-b border-[var(--color-border-light)] px-2 py-2">
        {git.isLoading ? (
          <div className="px-2 py-2 text-[var(--color-text-tertiary)]">加载中…</div>
        ) : groups.staged.length + groups.unstaged.length === 0 ? (
          <div className="px-2 py-2 text-[var(--color-text-tertiary)]">工作区没有变更</div>
        ) : (
          <>
            <ChangeGroup
              title="已暂存"
              changes={groups.staged}
              selected={selected}
              busy={busy}
              emptyText="没有已暂存的更改"
              allAction={{
                label: '全部取消暂存',
                icon: <Minus size={15} aria-hidden />,
                onClick: () =>
                  void runAction(
                    '取消暂存',
                    () => unstage.mutateAsync(undefined),
                    '已取消暂存',
                  ),
              }}
              onSelect={setSelected}
              onPrimaryAction={(change) =>
                void runAction('取消暂存', () => unstage.mutateAsync([change.path]), '已取消暂存')
              }
            />
            <ChangeGroup
              title="更改"
              changes={groups.unstaged}
              selected={selected}
              busy={busy}
              emptyText="没有未暂存的更改"
              allAction={{
                label: '全部暂存',
                icon: <Plus size={15} aria-hidden />,
                onClick: () =>
                  void runAction(
                    '暂存',
                    () => stage.mutateAsync(undefined),
                    '已全部暂存',
                  ),
              }}
              discardAllAction={
                discardableChanges.length === 0
                  ? undefined
                  : {
                      label:
                        discardableChanges.length === groups.unstaged.length
                          ? '丢弃所有未暂存更改'
                          : '丢弃所有可安全处理的未暂存更改',
                      onClick: () => {
                        setNotice(null);
                        setDiscardDraft(discardableChanges);
                      },
                    }
              }
              onSelect={setSelected}
              onPrimaryAction={(change) =>
                void runAction('暂存', () => stage.mutateAsync([change.path]), '已暂存')
              }
              onDiscard={(change) => {
                setNotice(null);
                setDiscardDraft([change]);
              }}
            />
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {selected === null ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[var(--color-text-tertiary)]">
            选择一个文件查看差异
          </div>
        ) : diff.isLoading ? (
          <div className="px-4 py-3 text-[var(--color-text-tertiary)]">加载差异…</div>
        ) : diff.isError ? (
          <div className="m-3 rounded-[var(--radius-md)] bg-[var(--color-background-button-secondary)] px-3 py-3 leading-6 text-[var(--color-text-secondary)]">
            {friendlyDiffError(diff.error)}
          </div>
        ) : (
          <DiffViewer
            change={selected}
            diff={diff.data?.diff ?? ''}
            truncated={diff.data?.truncated === true}
            onOpen={() => open.mutate({ path: selected.path, reveal: true })}
          />
        )}
      </div>

      {discardDraft === null ? null : (
        <DiscardDialog
          changes={discardDraft}
          pending={discard.isPending}
          error={notice?.tone === 'error' ? notice.text : undefined}
          onClose={() => setDiscardDraft(null)}
          onConfirm={() => {
            const includeUntracked = discardDraft.some((change) => change.status === 'untracked');
            void runAction(
              '丢弃更改',
              () => discard.mutateAsync({ paths: discardDraft.map((change) => change.path), includeUntracked }),
              '未暂存更改已丢弃',
            ).then((succeeded) => {
              if (succeeded) setDiscardDraft(null);
            });
          }}
        />
      )}
    </div>
  );
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="ui-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

interface GroupAction {
  readonly label: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}

function ChangeGroup({
  title,
  changes,
  selected,
  busy,
  emptyText,
  allAction,
  discardAllAction,
  onSelect,
  onPrimaryAction,
  onDiscard,
}: {
  readonly title: string;
  readonly changes: readonly GitChangeItem[];
  readonly selected: GitChangeItem | null;
  readonly busy: boolean;
  readonly emptyText: string;
  readonly allAction: GroupAction;
  readonly discardAllAction?: { readonly label: string; readonly onClick: () => void };
  readonly onSelect: (change: GitChangeItem) => void;
  readonly onPrimaryAction: (change: GitChangeItem) => void;
  readonly onDiscard?: (change: GitChangeItem) => void;
}) {
  return (
    <section className="mb-2 last:mb-0" aria-label={title}>
      <div className="flex h-8 items-center gap-1 px-1.5 font-medium text-[var(--color-text-secondary)]">
        <span className="min-w-0 flex-1 truncate">
          {title} <span className="font-normal text-[var(--color-text-tertiary)]">{changes.length}</span>
        </span>
        {discardAllAction === undefined || changes.length === 0 ? null : (
          <button
            type="button"
            aria-label={discardAllAction.label}
            title={discardAllAction.label}
            disabled={busy}
            onClick={discardAllAction.onClick}
            className="ui-pressable flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-danger)] disabled:opacity-40"
          >
            <Trash size={15} aria-hidden />
          </button>
        )}
        {changes.length === 0 ? null : (
          <button
            type="button"
            aria-label={allAction.label}
            title={allAction.label}
            disabled={busy}
            onClick={allAction.onClick}
            className="ui-pressable flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
          >
            {allAction.icon}
          </button>
        )}
      </div>
      {changes.length === 0 ? (
        <div className="px-2 py-1 text-[var(--color-text-tertiary)]">{emptyText}</div>
      ) : (
        <div role="list" className="space-y-0.5">
          {changes.map((change) => {
            const active = selected !== null && gitChangeKey(selected) === gitChangeKey(change);
            const discardable = canDiscardGitChange(change);
            return (
              <div
                key={gitChangeKey(change)}
                role="listitem"
                className={`group flex min-h-8 items-center rounded-[var(--radius-sm)] pr-1 ${
                  active ? 'bg-[var(--color-list-active)]' : 'hover:bg-[var(--color-list-hover)]'
                }`}
              >
                <button
                  type="button"
                  title={change.path}
                  onClick={() => onSelect(change)}
                  className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left"
                >
                  <span
                    className={`w-4 shrink-0 text-center font-mono font-semibold ${STATUS_TONE[change.status] ?? ''}`}
                  >
                    {statusAbbrev(change.status)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]">
                    {change.path}
                  </span>
                </button>
                {onDiscard === undefined || !discardable ? null : (
                  <button
                    type="button"
                    aria-label={`丢弃 ${change.path} 的未暂存更改`}
                    title="丢弃未暂存更改"
                    disabled={busy}
                    onClick={() => onDiscard(change)}
                    className="ui-pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-surface)] hover:text-[var(--color-text-danger)] disabled:opacity-40"
                  >
                    <Trash size={15} aria-hidden />
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`${change.cohort === 'staged' ? '取消暂存' : '暂存'} ${change.path}`}
                  title={change.cohort === 'staged' ? '取消暂存' : '暂存'}
                  disabled={busy}
                  onClick={() => onPrimaryAction(change)}
                  className="ui-pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-background-surface)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
                >
                  {change.cohort === 'staged' ? <Minus size={15} aria-hidden /> : <Plus size={15} aria-hidden />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function DiscardDialog({
  changes,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly changes: readonly GitChangeItem[];
  readonly pending: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const copy = gitDiscardCopy(changes);
  const closeUnlessPending = (): void => {
    if (!pending) onClose();
  };
  useModalDialog(dialogRef, closeUnlessPending, { initialFocusRef: cancelRef });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-terminal-shell)_40%,transparent)] px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-git-title"
        aria-describedby="discard-git-description"
        tabIndex={-1}
        className="w-full max-w-[420px] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border-heavy)] bg-[var(--color-background-surface)] text-[14px] shadow-[var(--shadow-floating-panel)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border-light)] px-4 py-3">
          <h2 id="discard-git-title" className="font-semibold text-[var(--color-text-foreground)]">
            {copy.title}
          </h2>
          <p id="discard-git-description" className="mt-1.5 leading-6 text-[var(--color-text-secondary)]">
            {copy.description}
          </p>
          {error === undefined ? null : (
            <p role="alert" className="mt-2 leading-6 text-[var(--color-text-danger)]">
              {error}
            </p>
          )}
        </div>
        <div className="max-h-36 overflow-y-auto bg-[var(--color-background-surface-under)] px-4 py-2 font-mono text-[var(--color-text-secondary)]">
          {changes.map((change) => (
            <div key={gitChangeKey(change)} className="truncate" title={change.path}>
              {change.path}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border-light)] px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            disabled={pending}
            onClick={onClose}
            className="ui-pressable rounded-[var(--radius-sm)] px-3 py-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={onConfirm}
            className="ui-pressable rounded-[var(--radius-sm)] bg-[var(--color-text-danger)] px-3 py-1.5 font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            {pending ? '处理中…' : copy.irreversible ? '永久删除并丢弃' : '丢弃更改'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiffViewer({
  change,
  diff,
  truncated,
  onOpen,
}: {
  readonly change: GitChangeItem;
  readonly diff: string;
  readonly truncated: boolean;
  readonly onOpen: () => void;
}) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const { adds, dels } = countChanges(lines);
  if (lines.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[14px] text-[var(--color-text-tertiary)]">
        <span>无文本差异（二进制文件或未跟踪）</span>
        <button
          type="button"
          onClick={onOpen}
          className="ui-pressable rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-list-hover)]"
        >
          在文件管理器中显示
        </button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-light)] px-3 py-2 text-[14px]">
        <span className="rounded-full bg-[var(--color-background-surface-under)] px-2 py-0.5 text-[var(--color-text-secondary)]">
          {change.cohort === 'staged' ? '已暂存' : '未暂存'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text-foreground)]" title={change.path}>
          {change.path}
        </span>
        <span className="shrink-0 font-mono">
          <span className="text-[var(--color-text-success)]">+{adds}</span>{' '}
          <span className="text-[var(--color-text-danger)]">−{dels}</span>
        </span>
        <button
          type="button"
          onClick={onOpen}
          title="在文件管理器中显示"
          aria-label="在文件管理器中显示"
          className="ui-pressable shrink-0 rounded-[var(--radius-sm)] p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-list-hover)] hover:text-[var(--color-text-foreground)]"
        >
          <ArrowUpRight size={16} aria-hidden />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto whitespace-pre py-1 font-mono"
        style={{ fontSize: 'var(--markdown-code-block-font-size)', lineHeight: 1.55 }}
      >
        {lines.map((line, index) => (
          <div key={index} className={`px-3 ${diffLineTone(line.type)}`}>
            <span className="select-none opacity-50">{diffPrefix(line.type)}</span>
            {line.text}
          </div>
        ))}
      </div>
      {truncated ? (
        <div className="shrink-0 border-t border-[var(--color-border-light)] px-3 py-1.5 text-[14px] text-[var(--color-text-warning)]">
          差异内容已截断
        </div>
      ) : null}
    </div>
  );
}

function statusAbbrev(status: string): string {
  return status === 'untracked'
    ? '?'
    : status === 'modified'
      ? 'M'
      : status === 'added'
        ? 'A'
        : status === 'deleted'
          ? 'D'
          : status === 'renamed'
            ? 'R'
            : status === 'conflicted'
              ? 'C'
              : status === 'ignored'
                ? '!'
                : status.slice(0, 1).toUpperCase();
}

function friendlyDiffError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not a git repository') || message.includes('40908')) {
    return '当前目录不是 Git 仓库，因此没有可显示的变更。';
  }
  if (message.includes('path_not_found') || message.includes('40409')) {
    return '文件已经移动或删除，请刷新变更列表。';
  }
  return '暂时无法加载文件差异，请稍后重试。';
}

function friendlyGitStatusError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('not a git repository') || message.includes('40908')) {
    return '当前目录不是 Git 仓库。文件浏览仍然可用，但这里不会显示变更。';
  }
  return '暂时无法读取 Git 变更，请稍后重试。';
}
