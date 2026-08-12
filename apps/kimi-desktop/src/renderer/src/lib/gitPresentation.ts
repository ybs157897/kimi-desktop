import type { FsGitStatusResponse } from '@moonshot-ai/protocol';

export type GitChangeCohort = 'staged' | 'unstaged';

export interface GitChangeItem {
  readonly cohort: GitChangeCohort;
  readonly path: string;
  readonly status: string;
}

export interface GitChangeGroups {
  readonly staged: readonly GitChangeItem[];
  readonly unstaged: readonly GitChangeItem[];
}

export interface GitBranchPickerItem {
  readonly name: string;
  readonly current: boolean;
}

export function gitBranchPickerItems(
  branches: readonly string[],
  currentBranch: string | undefined,
  query: string,
): readonly GitBranchPickerItem[] {
  const orderedNames = currentBranch === undefined || currentBranch === ''
    ? branches
    : [currentBranch, ...branches.filter((branch) => branch !== currentBranch)];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...new Set(orderedNames)]
    .filter(
      (branch) => normalizedQuery === '' || branch.toLocaleLowerCase().includes(normalizedQuery),
    )
    .map((name) => ({ name, current: name === currentBranch }));
}

export function gitBranchCreationName(
  candidate: string,
  branches: readonly string[],
): string | null {
  const normalized = candidate.trim();
  return normalized !== '' && !branches.includes(normalized) ? normalized : null;
}

export function gitChangeGroups(data: FsGitStatusResponse | undefined): GitChangeGroups {
  if (data === undefined) return { staged: [], unstaged: [] };

  const stagedEntries = data.stagedEntries ?? {};
  const projectedUnstagedEntries = data.unstagedEntries ?? {};
  const hasCohortProjection =
    Object.keys(stagedEntries).length > 0 || Object.keys(projectedUnstagedEntries).length > 0;
  const unstagedEntries = hasCohortProjection ? projectedUnstagedEntries : data.entries;
  return {
    staged: sortedItems('staged', stagedEntries),
    unstaged: sortedItems('unstaged', unstagedEntries),
  };
}

function sortedItems(cohort: GitChangeCohort, entries: Readonly<Record<string, string>>): GitChangeItem[] {
  return Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, status]) => ({ cohort, path, status }));
}

export function gitChangeKey(change: Pick<GitChangeItem, 'cohort' | 'path'>): string {
  return `${change.cohort}:${change.path}`;
}

export function canDiscardGitChange(change: GitChangeItem): boolean {
  return change.cohort === 'unstaged' && change.status !== 'conflicted';
}

export function gitDiscardCopy(changes: readonly GitChangeItem[]): {
  readonly title: string;
  readonly description: string;
  readonly irreversible: boolean;
} {
  const hasUntracked = changes.some((change) => change.status === 'untracked');
  if (hasUntracked) {
    return {
      title: changes.length === 1 ? '删除未跟踪文件？' : `丢弃 ${changes.length} 项未暂存更改？`,
      description: '未跟踪文件会被永久删除，其余文件会恢复到暂存区中的内容。此操作无法撤销。',
      irreversible: true,
    };
  }
  return {
    title: changes.length === 1 ? '丢弃未暂存更改？' : `丢弃 ${changes.length} 项未暂存更改？`,
    description: '文件会恢复到暂存区中的内容。已暂存的更改不会受到影响。',
    irreversible: false,
  };
}

export function friendlyGitOperationError(error: unknown, action: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const detail = gitErrorDetail(error);
  const diagnostic = `${message}\n${detail ?? ''}`;
  if (diagnostic.includes('not a git repository') || diagnostic.includes('40908')) {
    return '当前目录不是 Git 仓库。';
  }
  if (/conflict|unmerged|would be overwritten/i.test(diagnostic)) {
    return `${action}失败：仓库中存在冲突或未保存的更改。`;
  }
  if (/authentication|permission denied|could not read Username|terminal prompts disabled/i.test(diagnostic)) {
    return `${action}失败：远端身份验证未通过。`;
  }
  if (/no tracking information|no upstream|has no upstream branch/i.test(diagnostic)) {
    return `${action}失败：当前分支还没有配置上游分支。`;
  }
  if (/nothing to commit/i.test(diagnostic)) {
    return '没有可提交的已暂存更改。';
  }
  if (/session is busy|session\.busy|40901|当前任务仍在运行/i.test(diagnostic)) {
    return '当前任务仍在运行，请等待任务结束后再生成提交信息。';
  }
  if (/repository root workspace/i.test(diagnostic)) {
    return `${action}失败：请将 Git 仓库根目录作为项目打开后重试。`;
  }
  const reason = redactGitDiagnostic(detail ?? message);
  return `${action}失败。${reason.trim() === '' ? '请稍后重试。' : reason}`;
}

function gitErrorDetail(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('details' in error)) return undefined;
  const details = error.details;
  if (typeof details === 'string' && details.trim() !== '') return details;
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return undefined;
  for (const key of ['detail', 'stderr', 'message', 'error']) {
    const value = (details as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function redactGitDiagnostic(value: string): string {
  const firstLines = value.trim().split(/\r?\n/).slice(0, 3).join(' ');
  return firstLines
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1')
    .replace(/([?&](?:access_token|token|key|password)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 320);
}
