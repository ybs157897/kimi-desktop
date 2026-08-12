/**
 * `workspaceGit` domain — `IWorkspaceGitService` implementation.
 *
 * Delegates every call to the App-scope `IGitService` with `cwd` pinned to
 * the handler's workspace root (`IWorkspaceContext.cwd`). It preserves call
 * order for this handler; the App service provides cross-handler repository
 * serialization. Bound at Workspace scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  type FsDiffResponse,
  type FsDiffMode,
  type FsGitBranchesResponse,
  type FsGitCheckoutResponse,
  type FsGitCommitResponse,
  type FsGitCreateBranchResponse,
  type FsGitDiscardResponse,
  type FsGitPullResponse,
  type FsGitPushResponse,
  type FsGitStageResponse,
  type FsGitStatusResponse,
  type FsGitUnstageResponse,
  IGitService,
} from '#/app/git/git';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IWorkspaceGitService } from './workspaceGit';

export class WorkspaceGitService implements IWorkspaceGitService {
  declare readonly _serviceBrand: undefined;

  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IGitService private readonly git: IGitService,
  ) {}

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse> {
    return this.git.status(this.workspace.cwd, pathFilter);
  }

  branches(): Promise<FsGitBranchesResponse> {
    return this.git.branches(this.workspace.cwd);
  }

  checkout(branch: string): Promise<FsGitCheckoutResponse> {
    return this.enqueueMutation(() => this.git.checkout(this.workspace.cwd, branch));
  }

  stage(paths: readonly string[]): Promise<FsGitStageResponse> {
    return this.enqueueMutation(() => this.git.stage(this.workspace.cwd, paths));
  }

  unstage(paths: readonly string[]): Promise<FsGitUnstageResponse> {
    return this.enqueueMutation(() => this.git.unstage(this.workspace.cwd, paths));
  }

  discard(paths: readonly string[], includeUntracked: boolean): Promise<FsGitDiscardResponse> {
    return this.enqueueMutation(() => this.git.discard(this.workspace.cwd, paths, includeUntracked));
  }

  commit(message: string): Promise<FsGitCommitResponse> {
    return this.enqueueMutation(() => this.git.commit(this.workspace.cwd, message));
  }

  pull(rebase: boolean): Promise<FsGitPullResponse> {
    return this.enqueueMutation(() => this.git.pull(this.workspace.cwd, rebase));
  }

  push(setUpstream: boolean): Promise<FsGitPushResponse> {
    return this.enqueueMutation(() => this.git.push(this.workspace.cwd, setUpstream));
  }

  createBranch(branch: string, checkout: boolean): Promise<FsGitCreateBranchResponse> {
    return this.enqueueMutation(() => this.git.createBranch(this.workspace.cwd, branch, checkout));
  }

  diff(relPath: string, absPath: string, mode: FsDiffMode = 'all'): Promise<FsDiffResponse> {
    return this.git.diff(this.workspace.cwd, relPath, absPath, mode);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceGitService,
  WorkspaceGitService,
  ScopeActivation.OnScopeCreated,
  'workspaceGit',
);
