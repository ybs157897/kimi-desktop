/**
 * `workspaceGit` domain — handler-root-bound git facade contract.
 *
 * Defines the `IWorkspaceGitService`, a thin facade over the App-scope
 * `IGitService` pinned to this handler's workspace root: callers pass
 * repo-relative paths only, never a `cwd`. Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
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
} from '#/app/git/git';

export interface IWorkspaceGitService {
  readonly _serviceBrand: undefined;

  status(pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  branches(): Promise<FsGitBranchesResponse>;
  checkout(branch: string): Promise<FsGitCheckoutResponse>;
  stage(paths: readonly string[]): Promise<FsGitStageResponse>;
  unstage(paths: readonly string[]): Promise<FsGitUnstageResponse>;
  discard(paths: readonly string[], includeUntracked: boolean): Promise<FsGitDiscardResponse>;
  commit(message: string): Promise<FsGitCommitResponse>;
  pull(rebase: boolean): Promise<FsGitPullResponse>;
  push(setUpstream: boolean): Promise<FsGitPushResponse>;
  createBranch(branch: string, checkout: boolean): Promise<FsGitCreateBranchResponse>;
  diff(relPath: string, absPath: string, mode?: FsDiffMode): Promise<FsDiffResponse>;
}

export const IWorkspaceGitService: ServiceIdentifier<IWorkspaceGitService> =
  createDecorator<IWorkspaceGitService>('workspaceGitService');
