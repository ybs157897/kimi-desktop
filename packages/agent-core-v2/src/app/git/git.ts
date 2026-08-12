/**
 * `git` domain — git integration for a repository on the local disk.
 *
 * Defines the `IGitService` for status, diff, staging, discard, commit,
 * branch, pull, and push operations against a repository identified by an
 * absolute `cwd`, plus enclosing-work-tree discovery. App-scoped; it spawns
 * `git` / `gh` through the host process service rather than a Session's
 * execution environment, so it never depends on a Session. Path confinement
 * is the caller's responsibility — the service receives already-resolved
 * absolute `cwd` and repo-relative paths.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { GitWorkTree } from './workTree';

export type { GitWorkTree } from './workTree';

export const fsGitStatusSchema = z.enum([
  'clean',
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
  'ignored',
  'conflicted',
]);
export type FsGitStatus = z.infer<typeof fsGitStatusSchema>;

export const fsPullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'merged', 'closed', 'draft']),
  url: z.string().url(),
});
export type FsPullRequest = z.infer<typeof fsPullRequestSchema>;

export const fsGitStatusRequestSchema = z.object({
  paths: z.array(z.string().min(1)).optional(),
});
export type FsGitStatusRequest = z.infer<typeof fsGitStatusRequestSchema>;

export const fsGitStatusResponseSchema = z.object({
  branch: z.string(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.record(z.string(), fsGitStatusSchema),
  stagedEntries: z.record(z.string(), fsGitStatusSchema).default({}),
  unstagedEntries: z.record(z.string(), fsGitStatusSchema).default({}),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  pullRequest: fsPullRequestSchema.nullable(),
});
export type FsGitStatusResponse = z.infer<typeof fsGitStatusResponseSchema>;

export const fsGitBranchesResponseSchema = z.object({
  current: z.string(),
  branches: z.array(z.string()),
});
export type FsGitBranchesResponse = z.infer<typeof fsGitBranchesResponseSchema>;

export const fsGitCheckoutRequestSchema = z.object({ branch: z.string().min(1) });
export type FsGitCheckoutRequest = z.infer<typeof fsGitCheckoutRequestSchema>;

export const fsGitCheckoutResponseSchema = z.object({ branch: z.string() });
export type FsGitCheckoutResponse = z.infer<typeof fsGitCheckoutResponseSchema>;

export const fsGitPathsRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(1000),
});

export const fsGitStageRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(1000).optional(),
});
export type FsGitStageRequest = z.infer<typeof fsGitStageRequestSchema>;
export const fsGitStageResponseSchema = fsGitPathsRequestSchema;
export type FsGitStageResponse = z.infer<typeof fsGitStageResponseSchema>;

export const fsGitUnstageRequestSchema = fsGitStageRequestSchema;
export type FsGitUnstageRequest = z.infer<typeof fsGitUnstageRequestSchema>;
export const fsGitUnstageResponseSchema = fsGitPathsRequestSchema;
export type FsGitUnstageResponse = z.infer<typeof fsGitUnstageResponseSchema>;

export const fsGitDiscardRequestSchema = fsGitPathsRequestSchema.extend({
  include_untracked: z.boolean().default(false),
});
export type FsGitDiscardRequest = z.infer<typeof fsGitDiscardRequestSchema>;
export const fsGitDiscardResponseSchema = fsGitPathsRequestSchema;
export type FsGitDiscardResponse = z.infer<typeof fsGitDiscardResponseSchema>;

export const fsGitCommitRequestSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
});
export type FsGitCommitRequest = z.infer<typeof fsGitCommitRequestSchema>;
export const fsGitCommitResponseSchema = z.object({ commit: z.string().min(1) });
export type FsGitCommitResponse = z.infer<typeof fsGitCommitResponseSchema>;

export const fsGitGenerateCommitMessageRequestSchema = z.object({
  draft: z.string().max(10_000).optional(),
  include_unstaged: z.boolean().default(true),
});
export type FsGitGenerateCommitMessageRequest = z.infer<
  typeof fsGitGenerateCommitMessageRequestSchema
>;
export const fsGitGenerateCommitMessageResponseSchema = z.object({
  message: z.string().trim().min(1).max(10_000),
});
export type FsGitGenerateCommitMessageResponse = z.infer<
  typeof fsGitGenerateCommitMessageResponseSchema
>;

export const fsGitPullRequestSchema = z.object({
  rebase: z.boolean().default(false),
});
export type FsGitPullRequest = z.infer<typeof fsGitPullRequestSchema>;
export const fsGitPullResponseSchema = z.object({ output: z.string() });
export type FsGitPullResponse = z.infer<typeof fsGitPullResponseSchema>;

export const fsGitPushRequestSchema = z.object({
  set_upstream: z.boolean().default(true),
});
export type FsGitPushRequest = z.infer<typeof fsGitPushRequestSchema>;
export const fsGitPushResponseSchema = z.object({ output: z.string() });
export type FsGitPushResponse = z.infer<typeof fsGitPushResponseSchema>;

export const fsGitCreateBranchRequestSchema = z.object({
  branch: z.string().trim().min(1),
  checkout: z.boolean().default(true),
});
export type FsGitCreateBranchRequest = z.infer<typeof fsGitCreateBranchRequestSchema>;
export const fsGitCreateBranchResponseSchema = z.object({ branch: z.string() });
export type FsGitCreateBranchResponse = z.infer<typeof fsGitCreateBranchResponseSchema>;

export const fsDiffRequestSchema = z.object({
  path: z.string().min(1),
  mode: z.enum(['all', 'staged', 'unstaged']).default('all'),
});
export type FsDiffRequest = z.infer<typeof fsDiffRequestSchema>;
export type FsDiffMode = FsDiffRequest['mode'];

export const fsDiffResponseSchema = z.object({
  path: z.string(),
  diff: z.string(),
  truncated: z.boolean(),
});
export type FsDiffResponse = z.infer<typeof fsDiffResponseSchema>;

export interface IGitService {
  readonly _serviceBrand: undefined;

  status(cwd: string, pathFilter?: ReadonlySet<string>): Promise<FsGitStatusResponse>;
  branches(cwd: string): Promise<FsGitBranchesResponse>;
  checkout(cwd: string, branch: string): Promise<FsGitCheckoutResponse>;
  stage(cwd: string, paths: readonly string[]): Promise<FsGitStageResponse>;
  unstage(cwd: string, paths: readonly string[]): Promise<FsGitUnstageResponse>;
  discard(
    cwd: string,
    paths: readonly string[],
    includeUntracked: boolean,
  ): Promise<FsGitDiscardResponse>;
  commit(cwd: string, message: string): Promise<FsGitCommitResponse>;
  pull(cwd: string, rebase: boolean): Promise<FsGitPullResponse>;
  push(cwd: string, setUpstream: boolean): Promise<FsGitPushResponse>;
  createBranch(
    cwd: string,
    branch: string,
    checkout: boolean,
  ): Promise<FsGitCreateBranchResponse>;
  diff(
    cwd: string,
    relPath: string,
    absPath: string,
    mode?: FsDiffMode,
  ): Promise<FsDiffResponse>;
  findWorkTree(cwd: string): Promise<GitWorkTree | null>;
}

export const IGitService: ServiceIdentifier<IGitService> =
  createDecorator<IGitService>('gitService');
