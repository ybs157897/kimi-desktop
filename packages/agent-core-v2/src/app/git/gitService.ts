/**
 * `git` domain — `IGitService` implementation.
 *
 * Runs status, diff, staging, discard, commit, branch, pull, and push
 * operations (plus `gh pr view`) against a repository on the local disk, and
 * discovers its enclosing git work tree. It serializes mutations by repository
 * root and sanitizes command output before returning or throwing. Process
 * spawning goes through `IHostProcessService`, and the path-existence probe in
 * `diff` goes through `IHostFileSystem`. Bound at App scope.
 */

import type {
  FsDiffResponse,
  FsDiffMode,
  FsGitBranchesResponse,
  FsGitCheckoutResponse,
  FsGitCommitResponse,
  FsGitCreateBranchResponse,
  FsGitDiscardResponse,
  FsGitPullResponse,
  FsGitPushResponse,
  FsGitStageResponse,
  FsGitStatusResponse,
  FsGitUnstageResponse,
  FsPullRequest,
} from './git';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, Error2 } from '#/errors';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { IGitService } from './git';
import { sanitizeGitOutput } from './gitOutputSanitizer';
import { parseNumstat, parsePorcelain, parsePullRequest } from './gitParsers';
import { findGitWorkTree, type GitWorkTree } from './workTree';

const DIFF_MAX_BYTES = 1_048_576;

const PR_SPAWN_TIMEOUT_MS = 5_000;
const PULL_REQUEST_TTL_MS = 60_000;
const NETWORK_COMMAND_TIMEOUT_MS = 120_000;
const NON_INTERACTIVE_GIT_ENV = {
  GCM_INTERACTIVE: 'Never',
  GIT_TERMINAL_PROMPT: '0',
  SSH_ASKPASS_REQUIRE: 'never',
} as const;

export class GitService implements IGitService {
  declare readonly _serviceBrand: undefined;

  private readonly pullRequestCache = new Map<
    string,
    { value: FsPullRequest | null; fetchedAt: number }
  >();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    @IHostProcessService private readonly hostProcess: IHostProcessService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
  ) {}

  async status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const prefixResult = await this.runCommand('git', ['rev-parse', '--show-prefix'], cwd);
    if (prefixResult.exitCode !== 0) {
      throw this.gitUnavailable(
        cwd,
        prefixResult.stderr.trim() || `git rev-parse exit ${prefixResult.exitCode}`,
      );
    }
    const workspacePrefix = stripTrailingLineEnd(prefixResult.stdout);

    const porc = await this.runCommand(
      'git',
      ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--', '.'],
      cwd,
    );
    if (porc.exitCode !== 0) {
      throw this.gitUnavailable(cwd, porc.stderr.trim() || `git status exit ${porc.exitCode}`);
    }

    const result = parsePorcelain(porc.stdout, undefined);
    const dirty = Object.keys(result.entries).length > 0;
    result.entries = relativizeEntries(result.entries, workspacePrefix, pathFilter);
    result.stagedEntries = relativizeEntries(result.stagedEntries, workspacePrefix, pathFilter);
    result.unstagedEntries = relativizeEntries(result.unstagedEntries, workspacePrefix, pathFilter);

    if (dirty) {
      const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
      if (head.exitCode === 0) {
        const numstat = await this.runCommand(
          'git',
          ['diff', '--no-color', '--numstat', 'HEAD', '--', '.'],
          cwd,
        );
        if (numstat.exitCode === 0) {
          const stats = parseNumstat(numstat.stdout);
          result.additions = stats.additions;
          result.deletions = stats.deletions;
        }
      }
    }

    result.pullRequest = await this.readPullRequest(cwd, result.branch);
    return result;
  }

  async branches(cwd: string): Promise<FsGitBranchesResponse> {
    const result = await this.runCommand(
      'git',
      ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads/'],
      cwd,
    );
    if (result.exitCode !== 0) {
      throw this.gitUnavailable(cwd, result.stderr.trim() || `git for-each-ref exit ${result.exitCode}`);
    }
    const currentResult = await this.runCommand('git', ['branch', '--show-current'], cwd);
    if (currentResult.exitCode !== 0) {
      throw this.gitUnavailable(cwd, currentResult.stderr.trim() || `git branch exit ${currentResult.exitCode}`);
    }
    const current = currentResult.stdout.trim();
    const branches = result.stdout.split('\n').map((branch) => branch.trim()).filter(Boolean);
    return { current, branches };
  }

  async checkout(cwd: string, branch: string): Promise<FsGitCheckoutResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.checkoutImpl(cwd, branch));
  }

  private async checkoutImpl(cwd: string, branch: string): Promise<FsGitCheckoutResponse> {
    await this.assertRepositoryRootOperation(cwd, 'branch checkout');
    const valid = await this.runCommand('git', ['check-ref-format', '--branch', branch], cwd);
    if (valid.exitCode !== 0) {
      throw this.gitUnavailable(cwd, valid.stderr.trim() || `invalid branch: ${branch}`);
    }
    const result = await this.runCommand('git', ['switch', '--', branch], cwd);
    if (result.exitCode !== 0) {
      throw this.gitUnavailable(cwd, result.stderr.trim() || `git switch exit ${result.exitCode}`);
    }
    this.pullRequestCache.clear();
    return { branch };
  }

  async stage(cwd: string, paths: readonly string[]): Promise<FsGitStageResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.stageImpl(cwd, paths));
  }

  private async stageImpl(cwd: string, paths: readonly string[]): Promise<FsGitStageResponse> {
    const args = paths.length === 1 && paths[0] === '.'
      ? ['add', '-A', '--', '.']
      : ['add', '--', ...paths];
    const result = await this.runCommand('git', args, cwd);
    this.assertGitSuccess(cwd, result, 'git add');
    return { paths: [...paths] };
  }

  async unstage(cwd: string, paths: readonly string[]): Promise<FsGitUnstageResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.unstageImpl(cwd, paths));
  }

  private async unstageImpl(cwd: string, paths: readonly string[]): Promise<FsGitUnstageResponse> {
    const expandedPaths = await this.expandStagedRenamePaths(cwd, paths);
    const head = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const args = head.exitCode === 0
      ? ['reset', '--quiet', 'HEAD', '--', ...expandedPaths]
      : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...expandedPaths];
    const result = await this.runCommand('git', args, cwd);
    this.assertGitSuccess(cwd, result, 'git unstage');
    return { paths: [...paths] };
  }

  async discard(
    cwd: string,
    paths: readonly string[],
    includeUntracked: boolean,
  ): Promise<FsGitDiscardResponse> {
    return this.enqueueRepositoryMutation(
      cwd,
      () => this.discardImpl(cwd, paths, includeUntracked),
    );
  }

  private async discardImpl(
    cwd: string,
    paths: readonly string[],
    includeUntracked: boolean,
  ): Promise<FsGitDiscardResponse> {
    const status = await this.status(cwd, new Set(paths));
    const conflicted = paths.filter(
      (path) => status.entries[path] === 'conflicted',
    );
    if (conflicted.length > 0) {
      throw this.gitUnavailable(cwd, 'conflicted paths must be resolved before discarding');
    }
    const withoutWorktreeChange = paths.filter(
      (path) => status.unstagedEntries[path] === undefined,
    );
    if (withoutWorktreeChange.length > 0) {
      throw this.gitUnavailable(cwd, 'discard only accepts paths with working tree changes');
    }
    const untracked = paths.filter((path) => status.unstagedEntries[path] === 'untracked');
    if (untracked.length > 0 && !includeUntracked) {
      throw this.gitUnavailable(cwd, 'untracked paths require include_untracked=true');
    }
    const tracked = paths.filter((path) => !untracked.includes(path));
    if (tracked.length > 0) {
      const restored = await this.runCommand('git', ['restore', '--worktree', '--', ...tracked], cwd);
      this.assertGitSuccess(cwd, restored, 'git restore');
    }
    if (untracked.length > 0) {
      const cleaned = await this.runCommand('git', ['clean', '-fd', '--', ...untracked], cwd);
      this.assertGitSuccess(cwd, cleaned, 'git clean');
    }
    return { paths: [...paths] };
  }

  async commit(cwd: string, message: string): Promise<FsGitCommitResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.commitImpl(cwd, message));
  }

  private async commitImpl(cwd: string, message: string): Promise<FsGitCommitResponse> {
    await this.assertRepositoryRootOperation(cwd, 'commit');
    const result = await this.runCommand(
      'git',
      ['commit', '-m', message],
      cwd,
      { env: NON_INTERACTIVE_GIT_ENV },
    );
    this.assertGitSuccess(cwd, result, 'git commit');
    const head = await this.runCommand('git', ['rev-parse', 'HEAD'], cwd);
    this.assertGitSuccess(cwd, head, 'git rev-parse HEAD');
    this.pullRequestCache.clear();
    return { commit: head.stdout.trim() };
  }

  async pull(cwd: string, rebase: boolean): Promise<FsGitPullResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.pullImpl(cwd, rebase));
  }

  private async pullImpl(cwd: string, rebase: boolean): Promise<FsGitPullResponse> {
    await this.assertRepositoryRootOperation(cwd, 'pull');
    const args = rebase ? ['pull', '--rebase'] : ['pull', '--ff-only'];
    const result = await this.runCommand('git', args, cwd, {
      env: NON_INTERACTIVE_GIT_ENV,
      timeoutMs: NETWORK_COMMAND_TIMEOUT_MS,
    });
    this.assertGitSuccess(cwd, result, 'git pull');
    this.pullRequestCache.clear();
    return { output: commandOutput(result, cwd) };
  }

  async push(cwd: string, setUpstream: boolean): Promise<FsGitPushResponse> {
    return this.enqueueRepositoryMutation(cwd, () => this.pushImpl(cwd, setUpstream));
  }

  private async pushImpl(cwd: string, setUpstream: boolean): Promise<FsGitPushResponse> {
    const branch = await this.runCommand('git', ['branch', '--show-current'], cwd);
    this.assertGitSuccess(cwd, branch, 'git branch --show-current');
    const branchName = branch.stdout.trim();
    if (branchName === '') throw this.gitUnavailable(cwd, 'cannot push a detached HEAD');
    const upstream = await this.runCommand(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      cwd,
    );
    let args: string[] = ['push', '--', '@{push}', branchName];
    if (upstream.exitCode !== 0 && setUpstream) {
      const remotes = await this.runCommand('git', ['remote'], cwd);
      this.assertGitSuccess(cwd, remotes, 'git remote');
      const remoteNames = remotes.stdout.split('\n').map((value) => value.trim()).filter(Boolean);
      const remote = remoteNames.includes('origin')
        ? 'origin'
        : remoteNames.length === 1
          ? remoteNames[0]
          : undefined;
      if (remote === undefined) {
        const detail = remoteNames.length === 0
          ? 'no git remote is configured'
          : 'multiple git remotes are configured and none is named origin';
        throw this.gitUnavailable(cwd, detail);
      }
      args = ['push', '--set-upstream', '--', remote, branchName];
    } else if (upstream.exitCode === 0) {
      const remote = await this.runCommand('git', ['config', '--get', `branch.${branchName}.remote`], cwd);
      this.assertGitSuccess(cwd, remote, 'git config branch remote');
      const merge = await this.runCommand('git', ['config', '--get', `branch.${branchName}.merge`], cwd);
      this.assertGitSuccess(cwd, merge, 'git config branch merge');
      const mergeRef = merge.stdout.trim();
      if (!mergeRef.startsWith('refs/heads/')) {
        throw this.gitUnavailable(cwd, 'the configured upstream is not a branch');
      }
      args = ['push', '--', remote.stdout.trim(), `HEAD:${mergeRef}`];
    } else {
      throw this.gitUnavailable(cwd, 'the current branch has no upstream');
    }
    const result = await this.runCommand('git', args, cwd, {
      env: NON_INTERACTIVE_GIT_ENV,
      timeoutMs: NETWORK_COMMAND_TIMEOUT_MS,
    });
    this.assertGitSuccess(cwd, result, 'git push');
    this.pullRequestCache.clear();
    return { output: commandOutput(result, cwd) };
  }

  async createBranch(
    cwd: string,
    branch: string,
    checkout: boolean,
  ): Promise<FsGitCreateBranchResponse> {
    return this.enqueueRepositoryMutation(
      cwd,
      () => this.createBranchImpl(cwd, branch, checkout),
    );
  }

  private async createBranchImpl(
    cwd: string,
    branch: string,
    checkout: boolean,
  ): Promise<FsGitCreateBranchResponse> {
    if (checkout) await this.assertRepositoryRootOperation(cwd, 'branch checkout');
    const valid = await this.runCommand('git', ['check-ref-format', '--branch', branch], cwd);
    this.assertGitSuccess(cwd, valid, 'git check-ref-format');
    const args = checkout ? ['switch', '-c', branch] : ['branch', branch];
    const result = await this.runCommand('git', args, cwd);
    this.assertGitSuccess(cwd, result, checkout ? 'git switch -c' : 'git branch');
    this.pullRequestCache.clear();
    return { branch };
  }

  async diff(
    cwd: string,
    relPath: string,
    absPath: string,
    mode: FsDiffMode = 'all',
  ): Promise<FsDiffResponse> {
    const inside = await this.runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw this.gitUnavailable(cwd, inside.stderr.trim() || `git rev-parse exit ${inside.exitCode}`);
    }

    const statusRes = await this.runCommand('git', ['status', '--porcelain=v1', '--', relPath], cwd);
    if (statusRes.exitCode !== 0) {
      throw this.gitUnavailable(cwd, statusRes.stderr.trim() || `git status exit ${statusRes.exitCode}`);
    }
    const untracked = statusRes.stdout.startsWith('??');

    const headRes = await this.runCommand('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
    const hasHead = headRes.exitCode === 0;

    let diffStdout: string;
    if (mode === 'staged') {
      const res = await this.runCommand('git', ['diff', '--no-color', '--cached', '--', relPath], cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else if (untracked || (mode === 'all' && !hasHead)) {
      const res = await this.runCommand(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', relPath],
        cwd,
      );
      if (res.exitCode !== 0 && res.exitCode !== 1) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      diffStdout = res.stdout;
    } else {
      const args = mode === 'unstaged'
        ? ['diff', '--no-color', '--', relPath]
        : ['diff', '--no-color', 'HEAD', '--', relPath];
      const res = await this.runCommand('git', args, cwd);
      if (res.exitCode !== 0) {
        throw this.gitUnavailable(cwd, res.stderr.trim() || `git diff exit ${res.exitCode}`);
      }
      if (res.stdout.length === 0 && statusRes.stdout.length === 0) {
        const exists = await this.fs.lstat(absPath).then(
          () => true,
          () => false,
        );
        if (!exists) {
          throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `path not found: ${relPath}`, {
            details: { path: relPath },
          });
        }
      }
      diffStdout = res.stdout;
    }

    const truncated = diffStdout.length > DIFF_MAX_BYTES;
    return {
      path: relPath,
      diff: truncated ? diffStdout.slice(0, DIFF_MAX_BYTES) : diffStdout,
      truncated,
    };
  }

  findWorkTree(cwd: string): Promise<GitWorkTree | null> {
    return findGitWorkTree(this.fs, cwd);
  }

  private async readPullRequest(cwd: string, branch: string): Promise<FsPullRequest | null> {
    const cacheKey = `${cwd}\0${branch}`;
    const cached = this.pullRequestCache.get(cacheKey);
    const now = Date.now();
    if (cached !== undefined && now - cached.fetchedAt < PULL_REQUEST_TTL_MS) {
      return cached.value;
    }

    const res = await this.runCommand(
      'gh',
      ['pr', 'view', '--json', 'number,url,state'],
      cwd,
      {
        env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' },
        timeoutMs: PR_SPAWN_TIMEOUT_MS,
      },
    );
    const value = res.exitCode === 0 ? parsePullRequest(res.stdout) : null;
    this.pullRequestCache.set(cacheKey, { value, fetchedAt: now });
    return value;
  }

  private assertGitSuccess(cwd: string, result: RunResult, operation: string): void {
    if (result.exitCode === 0) return;
    throw this.gitUnavailable(
      cwd,
      result.stderr.trim() || result.stdout.trim() || `${operation} exit ${result.exitCode}`,
    );
  }

  private async expandStagedRenamePaths(
    cwd: string,
    paths: readonly string[],
  ): Promise<readonly string[]> {
    const prefixResult = await this.runCommand('git', ['rev-parse', '--show-prefix'], cwd);
    this.assertGitSuccess(cwd, prefixResult, 'git rev-parse --show-prefix');
    const workspacePrefix = stripTrailingLineEnd(prefixResult.stdout);
    const status = await this.runCommand(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
      cwd,
    );
    this.assertGitSuccess(cwd, status, 'git status');
    const expanded = new Set(paths);
    const requested = new Set(paths);
    const records = status.stdout.split('\0');
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] ?? '';
      if (record.length < 4) continue;
      const code = record.charAt(0);
      if (code !== 'R' && code !== 'C') continue;
      const destination = relativeToWorkspace(record.slice(3), workspacePrefix);
      const source = relativeToWorkspace(records[index + 1] ?? '', workspacePrefix);
      index += 1;
      if (destination !== undefined && source !== undefined && requested.has(destination)) {
        expanded.add(source);
      }
    }
    return [...expanded];
  }

  private async assertRepositoryRootOperation(cwd: string, operation: string): Promise<void> {
    const prefix = await this.runCommand('git', ['rev-parse', '--show-prefix'], cwd);
    this.assertGitSuccess(cwd, prefix, 'git rev-parse --show-prefix');
    if (stripTrailingLineEnd(prefix.stdout) !== '') {
      throw this.gitUnavailable(
        cwd,
        `${operation} must be run from the repository root workspace`,
      );
    }
  }

  private async enqueueRepositoryMutation<T>(
    cwd: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const root = await this.runCommand(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      cwd,
    );
    this.assertGitSuccess(cwd, root, 'git rev-parse --git-common-dir');
    const key = stripTrailingLineEnd(root.stdout);
    const previous = this.mutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(key, tail);
    void tail.finally(() => {
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key);
    });
    return result;
  }

  private async runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    options: RunOptions = {},
  ): Promise<RunResult> {
    const env = cmd === 'git'
      ? { GIT_LITERAL_PATHSPECS: '1', ...options.env }
      : options.env;
    const spawned = await this.hostProcess
      .spawn(cmd, args, { cwd, env })
      .then(
        (proc) => ({ ok: true as const, proc }),
        () => ({ ok: false as const }),
      );
    if (!spawned.ok) {
      return { exitCode: -1, stdout: '', stderr: '' };
    }
    const { proc } = spawned;

    const work = Promise.all([
      collect(proc.stdout),
      collect(proc.stderr),
      proc.wait().catch(() => -1),
    ] as const);
    work.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.timeoutMs === undefined) {
        const [stdout, stderr, exitCode] = await work;
        return { exitCode, stdout, stderr };
      }
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([
        work.then(
          ([stdout, stderr, exitCode]) =>
            ({ kind: 'done' as const, stdout, stderr, exitCode }),
        ),
        timeout.then((kind) => ({ kind })),
      ]);
      if (result.kind === 'done') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      await proc.kill('SIGKILL').catch(() => {});
      const [stdout, stderr] = await work
        .then(([so, se]) => [so, se] as const)
        .catch(() => ['', ''] as const);
      return { exitCode: -1, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      proc.dispose();
    }
  }

  private gitUnavailable(cwd: string, detail: string): Error2 {
    return new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'Git operation failed', {
      details: { detail: sanitizeGitOutput(detail, cwd) },
    });
  }
}

function relativizeEntries(
  entries: FsGitStatusResponse['entries'],
  workspacePrefix: string,
  pathFilter: ReadonlySet<string> | undefined,
): FsGitStatusResponse['entries'] {
  const result: FsGitStatusResponse['entries'] = {};
  for (const [path, status] of Object.entries(entries)) {
    if (workspacePrefix !== '' && !path.startsWith(workspacePrefix)) continue;
    const relativePath = workspacePrefix === '' ? path : path.slice(workspacePrefix.length);
    if (relativePath === '' || (pathFilter !== undefined && !pathFilter.has(relativePath))) continue;
    result[relativePath] = status;
  }
  return result;
}

function relativeToWorkspace(path: string, workspacePrefix: string): string | undefined {
  if (workspacePrefix !== '' && !path.startsWith(workspacePrefix)) return undefined;
  const relativePath = workspacePrefix === '' ? path : path.slice(workspacePrefix.length);
  return relativePath === '' ? undefined : relativePath;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function commandOutput(result: RunResult, cwd: string): string {
  return sanitizeGitOutput(
    [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n'),
    cwd,
  );
}

function stripTrailingLineEnd(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

registerScopedService(LifecycleScope.App, IGitService, GitService, ScopeActivation.OnScopeCreated, 'git');
