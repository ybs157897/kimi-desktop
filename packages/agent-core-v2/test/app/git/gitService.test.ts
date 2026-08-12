/**
 * Scenario: exercise the public Git service against isolated temporary repos.
 * Responsibilities: status/diff accuracy, safe local mutations, branch and
 * local-bare-remote synchronization and repository-wide mutation ordering.
 * Wiring: real HostProcess/HostFileSystem except one scripted queue boundary;
 * no external network. Run: pnpm --filter @moonshot-ai/agent-core-v2 exec
 * vitest run test/app/git/gitService.test.ts
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IGitService } from '#/app/git/git';
import { GitService } from '#/app/git/gitService';
import { findGitWorkTree } from '#/app/git/workTree';
import { ErrorCodes } from '#/errors';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { type IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { normalize } from 'pathe';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

function fakeProcess(stdout: string, wait: () => Promise<number>): IHostProcess {
  return {
    _serviceBrand: undefined,
    pid: 1,
    exitCode: null,
    stdin: new Writable({ write: (_chunk, _encoding, done) => done() }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([]),
    wait,
    kill: async () => undefined,
    dispose: () => undefined,
  };
}

describe('GitService', () => {
  let repo: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let service: IGitService;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-service-'));
    git(repo, 'init');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
        reg.define(IHostFileSystem, HostFileSystem);
        reg.define(IGitService, GitService);
      },
    });
    service = ix.get(IGitService);
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  function commitAll(message: string): void {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', message);
  }

  describe('status', () => {
    it('reports a clean tree', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      const result = await service.status(repo);
      expect(typeof result.branch).toBe('string');
      expect(result.entries).toEqual({});
      expect(result.stagedEntries).toEqual({});
      expect(result.unstagedEntries).toEqual({});
      expect(result.additions).toBe(0);
      expect(result.deletions).toBe(0);
      expect(result.pullRequest).toBeNull();
    });

    it('reports a modified file with numstat', async () => {
      writeFileSync(join(repo, 'a.txt'), 'line1\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');

      const result = await service.status(repo);
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(0);
    });

    it('reports the index and working tree states when one path changes in both', async () => {
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'staged\n');
      git(repo, 'add', 'a.txt');
      writeFileSync(join(repo, 'a.txt'), 'unstaged\n');

      const result = await service.status(repo);

      expect(result.stagedEntries).toEqual({ 'a.txt': 'modified' });
      expect(result.unstagedEntries).toEqual({ 'a.txt': 'modified' });
    });

    it('preserves whitespace, unicode, newline, and backslash in nul-delimited paths', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'base\n');
      commitAll('init');
      const paths = ['space ü.txt', 'tab\tname.txt', 'line\nname.txt', 'back\\slash.txt'];
      for (const path of paths) writeFileSync(join(repo, path), path);

      const result = await service.status(repo);

      expect(Object.keys(result.unstagedEntries).sort()).toEqual(paths.sort());
    });

    it('reports every untracked file inside nested directories', async () => {
      writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
      commitAll('init');
      mkdirSync(join(repo, '.agents', 'skills', 'animate'), { recursive: true });
      writeFileSync(join(repo, '.agents', 'skills', 'animate', 'SKILL.md'), 'skill\n');
      writeFileSync(join(repo, '.agents', 'skills', 'animate', 'RECIPES.md'), 'recipes\n');

      const result = await service.status(repo);

      expect(result.entries).toEqual({
        '.agents/skills/animate/RECIPES.md': 'untracked',
        '.agents/skills/animate/SKILL.md': 'untracked',
      });
    });

    it('restricts entries to the path filter', async () => {
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      writeFileSync(join(repo, 'b.txt'), 'b\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'a2\n');
      writeFileSync(join(repo, 'b.txt'), 'b2\n');

      const result = await service.status(repo, new Set(['a.txt']));
      expect(result.entries).toEqual({ 'a.txt': 'modified' });
    });

    it('reports paths relative to a nested workspace and excludes changes outside it', async () => {
      const workspace = join(repo, 'packages', 'example');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(repo, 'root.txt'), 'root\n');
      writeFileSync(join(workspace, 'nested.txt'), 'nested\n');
      commitAll('init');
      writeFileSync(join(repo, 'root.txt'), 'changed root\n');
      writeFileSync(join(workspace, 'nested.txt'), 'changed nested\n');

      const result = await service.status(workspace);

      expect(result.entries).toEqual({ 'nested.txt': 'modified' });
    });

    it('throws FS_GIT_UNAVAILABLE when not a repo', async () => {
      const notRepo = mkdtempSync(join(tmpdir(), 'not-repo-'));
      try {
        await expect(service.status(notRepo)).rejects.toMatchObject({
          code: ErrorCodes.FS_GIT_UNAVAILABLE,
        });
      } finally {
        rmSync(notRepo, { recursive: true, force: true });
      }
    });
  });

  describe('diff', () => {
    it('returns the unified diff for a tracked modified file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'old\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'new\n');

      const result = await service.diff(repo, 'a.txt', join(repo, 'a.txt'));
      expect(result.path).toBe('a.txt');
      expect(result.diff).toContain('+new');
      expect(result.diff).toContain('-old');
      expect(result.truncated).toBe(false);
    });

    it('returns an all-added diff for an untracked file', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      writeFileSync(join(repo, 'b.txt'), 'brand new\n');

      const result = await service.diff(repo, 'b.txt', join(repo, 'b.txt'));
      expect(result.diff).toContain('+brand new');
    });

    it('throws FS_PATH_NOT_FOUND for a missing path', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      await expect(
        service.diff(repo, 'missing.txt', join(repo, 'missing.txt')),
      ).rejects.toMatchObject({ code: ErrorCodes.FS_PATH_NOT_FOUND });
    });

    it('separates staged and unstaged patches for a path changed in both', async () => {
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'staged\n');
      git(repo, 'add', 'a.txt');
      writeFileSync(join(repo, 'a.txt'), 'unstaged\n');

      const staged = await service.diff(repo, 'a.txt', join(repo, 'a.txt'), 'staged');
      const unstaged = await service.diff(repo, 'a.txt', join(repo, 'a.txt'), 'unstaged');

      expect(staged.diff).toContain('+staged');
      expect(staged.diff).not.toContain('+unstaged');
      expect(unstaged.diff).toContain('-staged');
      expect(unstaged.diff).toContain('+unstaged');
    });

    it('returns a staged patch before the first commit', async () => {
      writeFileSync(join(repo, 'a.txt'), 'new\n');
      await service.stage(repo, ['a.txt']);

      const result = await service.diff(repo, 'a.txt', join(repo, 'a.txt'), 'staged');

      expect(result.diff).toContain('+new');
    });

    it('does not interpret pathspec magic when a diff path does not exist', async () => {
      writeFileSync(join(repo, 'outside.txt'), 'base\n');
      commitAll('init');
      writeFileSync(join(repo, 'outside.txt'), 'changed\n');

      await expect(
        service.diff(repo, ':(top)**', join(repo, ':(top)**'), 'unstaged'),
      ).rejects.toMatchObject({ code: ErrorCodes.FS_PATH_NOT_FOUND });
    });
  });

  describe('working tree mutations', () => {
    it('stages a file before the first commit', async () => {
      writeFileSync(join(repo, 'new.txt'), 'new\n');

      await service.stage(repo, ['new.txt']);

      expect((await service.status(repo)).stagedEntries).toEqual({ 'new.txt': 'added' });
    });

    it('treats wildcard characters in a staged filename literally', async () => {
      writeFileSync(join(repo, '[ab].txt'), 'literal\n');
      writeFileSync(join(repo, 'a.txt'), 'other\n');

      await service.stage(repo, ['[ab].txt']);

      expect((await service.status(repo)).stagedEntries).toEqual({ '[ab].txt': 'added' });
      expect((await service.status(repo)).unstagedEntries).toEqual({ 'a.txt': 'untracked' });
    });

    it('unstages a file before the first commit', async () => {
      writeFileSync(join(repo, 'new.txt'), 'new\n');
      await service.stage(repo, ['new.txt']);

      await service.unstage(repo, ['new.txt']);

      expect((await service.status(repo)).unstagedEntries).toEqual({ 'new.txt': 'untracked' });
    });

    it('unstages a modified index entry before the first commit without changing the working tree', async () => {
      writeFileSync(join(repo, 'new.txt'), 'staged\n');
      await service.stage(repo, ['new.txt']);
      writeFileSync(join(repo, 'new.txt'), 'latest\n');

      await service.unstage(repo, ['new.txt']);

      expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('latest\n');
      expect((await service.status(repo)).unstagedEntries).toEqual({ 'new.txt': 'untracked' });
    });

    it('unstages both sides of a staged rename', async () => {
      writeFileSync(join(repo, 'old.txt'), 'content\n');
      commitAll('init');
      git(repo, 'mv', 'old.txt', 'new.txt');

      await service.unstage(repo, ['new.txt']);

      expect((await service.status(repo)).entries).toEqual({
        'new.txt': 'untracked',
        'old.txt': 'deleted',
      });
    });

    it('discards only the unstaged layer of a path that is also staged', async () => {
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      commitAll('init');
      writeFileSync(join(repo, 'a.txt'), 'staged\n');
      git(repo, 'add', 'a.txt');
      writeFileSync(join(repo, 'a.txt'), 'unstaged\n');

      await service.discard(repo, ['a.txt'], false);

      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('staged\n');
      expect((await service.status(repo)).stagedEntries).toEqual({ 'a.txt': 'modified' });
      expect((await service.status(repo)).unstagedEntries).toEqual({});
    });

    it('keeps an untracked path when deletion is not explicitly allowed', async () => {
      writeFileSync(join(repo, 'new.txt'), 'new\n');

      await expect(service.discard(repo, ['new.txt'], false)).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
      });

      expect(existsSync(join(repo, 'new.txt'))).toBe(true);
    });

    it('deletes an untracked path when deletion is explicitly allowed', async () => {
      writeFileSync(join(repo, 'new.txt'), 'new\n');

      await service.discard(repo, ['new.txt'], true);

      expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    });

    it('treats wildcard characters in a discarded filename literally', async () => {
      writeFileSync(join(repo, '[ab].txt'), 'base\n');
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      commitAll('init');
      writeFileSync(join(repo, '[ab].txt'), 'literal change\n');
      writeFileSync(join(repo, 'a.txt'), 'other change\n');

      await service.discard(repo, ['[ab].txt'], false);

      expect(readFileSync(join(repo, '[ab].txt'), 'utf8')).toBe('base\n');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('other change\n');
    });

    it('creates a commit from the staged index', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      await service.stage(repo, ['a.txt']);

      const result = await service.commit(repo, 'initial commit');

      expect(result.commit).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect((await service.status(repo)).entries).toEqual({});
    });

    it('rejects discard for a conflicted path without changing conflict markers', async () => {
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      commitAll('init');
      const initial = git(repo, 'branch', '--show-current');
      git(repo, 'switch', '-c', 'side');
      writeFileSync(join(repo, 'a.txt'), 'side\n');
      commitAll('side');
      git(repo, 'switch', initial);
      writeFileSync(join(repo, 'a.txt'), 'main\n');
      commitAll('main');
      try {
        git(repo, 'merge', 'side');
      } catch {
      }

      await expect(service.discard(repo, ['a.txt'], false)).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
      });

      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    });

    it('rejects a nested-workspace commit when the repository index contains an outside path', async () => {
      const workspace = join(repo, 'packages', 'example');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(repo, 'outside.txt'), 'outside\n');
      writeFileSync(join(workspace, 'inside.txt'), 'inside\n');
      git(repo, 'add', '-A');

      await expect(service.commit(workspace, 'must not commit outside')).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
        details: {
          detail: 'commit must be run from the repository root workspace',
        },
      });

      expect(git(repo, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual([
        'outside.txt',
        'packages/example/inside.txt',
      ]);
      expect(() => git(repo, 'rev-parse', 'HEAD')).toThrow();
    });

    it('rejects a nested-workspace commit for a staged rename whose source is outside', async () => {
      const workspace = join(repo, 'packages', 'example');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(repo, 'outside.txt'), 'outside\n');
      commitAll('initial');
      git(repo, 'mv', 'outside.txt', 'packages/example/inside.txt');

      await expect(service.commit(workspace, 'must not cross workspace')).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
        details: {
          detail: 'commit must be run from the repository root workspace',
        },
      });

      expect(git(repo, 'status', '--porcelain')).toContain('outside.txt -> packages/example/inside.txt');
    });

    it('rejects a nested-workspace commit when its directory starts with a space', async () => {
      const workspace = join(repo, ' workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'inside.txt'), 'inside\n');
      writeFileSync(join(repo, 'outside.txt'), 'outside\n');
      git(repo, 'add', '-A');

      await expect(service.commit(workspace, 'nested')).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
        details: { detail: 'commit must be run from the repository root workspace' },
      });
    });
  });

  describe('remote synchronization', () => {
    it('pushes the current branch and establishes its upstream', async () => {
      const remote = mkdtempSync(join(tmpdir(), 'git-service-remote-'));
      try {
        execFileSync('git', ['init', '--bare', remote]);
        writeFileSync(join(repo, 'a.txt'), 'hello\n');
        commitAll('init');
        git(repo, 'remote', 'add', 'origin', remote);
        const branch = git(repo, 'branch', '--show-current');

        await service.push(repo, true);

        const remoteHead = execFileSync(
          'git',
          ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`],
          { encoding: 'utf8' },
        ).trim();
        expect(remoteHead).toBe(git(repo, 'rev-parse', 'HEAD'));
        expect(git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe(
          `origin/${branch}`,
        );
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('fast-forwards from the configured upstream', async () => {
      const remote = mkdtempSync(join(tmpdir(), 'git-service-remote-'));
      const peer = mkdtempSync(join(tmpdir(), 'git-service-peer-'));
      try {
        execFileSync('git', ['init', '--bare', remote]);
        writeFileSync(join(repo, 'a.txt'), 'base\n');
        commitAll('init');
        git(repo, 'remote', 'add', 'origin', remote);
        await service.push(repo, true);
        execFileSync('git', ['clone', remote, peer]);
        git(peer, 'config', 'user.email', 'test@example.com');
        git(peer, 'config', 'user.name', 'Test');
        writeFileSync(join(peer, 'a.txt'), 'remote\n');
        git(peer, 'add', 'a.txt');
        git(peer, 'commit', '-m', 'remote');
        git(peer, 'push');

        await service.pull(repo, false);

        expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('remote\n');
      } finally {
        rmSync(peer, { recursive: true, force: true });
        rmSync(remote, { recursive: true, force: true });
      }
    });

    it('pushes to an upstream whose branch name differs from the local branch', async () => {
      const remote = mkdtempSync(join(tmpdir(), 'git-service-remote-'));
      try {
        execFileSync('git', ['init', '--bare', remote]);
        writeFileSync(join(repo, 'a.txt'), 'base\n');
        commitAll('init');
        git(repo, 'remote', 'add', 'origin', remote);
        git(repo, 'push', '--set-upstream', 'origin', 'HEAD:main');
        git(repo, 'branch', '-m', 'release');
        git(repo, 'config', 'branch.release.remote', 'origin');
        git(repo, 'config', 'branch.release.merge', 'refs/heads/main');
        writeFileSync(join(repo, 'a.txt'), 'release\n');
        commitAll('release');

        await service.push(repo, false);

        const mainHead = execFileSync(
          'git',
          ['--git-dir', remote, 'rev-parse', 'refs/heads/main'],
          { encoding: 'utf8' },
        ).trim();
        expect(mainHead).toBe(git(repo, 'rev-parse', 'HEAD'));
        expect(() =>
          execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/release']),
        ).toThrow();
      } finally {
        rmSync(remote, { recursive: true, force: true });
      }
    });
  });

  describe('branches', () => {
    it('lists local branches and switches the working tree', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');
      const initial = git(repo, 'branch', '--show-current');
      git(repo, 'branch', 'feature/example');

      await expect(service.branches(repo)).resolves.toEqual({
        current: initial,
        branches: expect.arrayContaining([initial, 'feature/example']),
      });
      await expect(service.checkout(repo, 'feature/example')).resolves.toEqual({
        branch: 'feature/example',
      });
      expect(git(repo, 'branch', '--show-current')).toBe('feature/example');
    });

    it('rejects an invalid branch name without invoking switch', async () => {
      await expect(service.checkout(repo, '--bad')).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
      });
    });

    it('creates and switches to a valid branch', async () => {
      writeFileSync(join(repo, 'a.txt'), 'hello\n');
      commitAll('init');

      await expect(service.createBranch(repo, 'feature/new', true)).resolves.toEqual({
        branch: 'feature/new',
      });
      expect(git(repo, 'branch', '--show-current')).toBe('feature/new');
    });

    it('rejects checkout from a nested workspace before changing repository files', async () => {
      const workspace = join(repo, 'packages', 'example');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(repo, 'outside.txt'), 'main\n');
      commitAll('main');
      const initial = git(repo, 'branch', '--show-current');
      git(repo, 'switch', '-c', 'other');
      writeFileSync(join(repo, 'outside.txt'), 'other\n');
      commitAll('other');
      git(repo, 'switch', initial);

      await expect(service.checkout(workspace, 'other')).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
        details: { detail: 'branch checkout must be run from the repository root workspace' },
      });

      expect(git(repo, 'branch', '--show-current')).toBe(initial);
      expect(readFileSync(join(repo, 'outside.txt'), 'utf8')).toBe('main\n');
    });

    it('rejects pull from a nested workspace before running network synchronization', async () => {
      const workspace = join(repo, 'packages', 'example');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(repo, 'outside.txt'), 'main\n');
      commitAll('main');

      await expect(service.pull(workspace, false)).rejects.toMatchObject({
        code: ErrorCodes.FS_GIT_UNAVAILABLE,
        details: { detail: 'pull must be run from the repository root workspace' },
      });

      expect(readFileSync(join(repo, 'outside.txt'), 'utf8')).toBe('main\n');
    });
  });

  describe('findWorkTree', () => {
    it('finds the repo root from a nested subdirectory', async () => {
      mkdirSync(join(repo, 'a', 'b'), { recursive: true });

      const result = await service.findWorkTree(join(repo, 'a', 'b'));

      expect(result).toEqual({
        root: normalize(repo),
        dotGitPath: normalize(join(repo, '.git')),
        controlDirPath: normalize(join(repo, '.git')),
      });
    });

    it('returns null when no ancestor holds a .git entry', async () => {
      const plain = mkdtempSync(join(tmpdir(), 'git-service-plain-'));
      try {
        await expect(service.findWorkTree(plain)).resolves.toBeNull();
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it('resolves an absolute gitdir pointer in a .git file', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        const control = join(repo, '.git', 'worktrees', 'wt');
        writeFileSync(join(wt, '.git'), `gitdir: ${control}\n`);

        const result = await service.findWorkTree(wt);

        expect(result?.root).toBe(normalize(wt));
        expect(result?.dotGitPath).toBe(normalize(join(wt, '.git')));
        expect(result?.controlDirPath).toBe(normalize(control));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('resolves a relative gitdir pointer against the marker parent', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        writeFileSync(join(wt, '.git'), 'gitdir: ../gitdir-target\n');

        const result = await service.findWorkTree(wt);

        expect(result?.controlDirPath).toBe(normalize(join(wt, '..', 'gitdir-target')));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('parses a BOM-prefixed gitdir pointer', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'git-service-wt-'));
      try {
        writeFileSync(join(wt, '.git'), '\uFEFFgitdir: ../target\n');

        const result = await service.findWorkTree(wt);

        expect(result?.controlDirPath).toBe(normalize(join(wt, '..', 'target')));
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    it('skips a .git file without a gitdir pointer and keeps walking up', async () => {
      const inner = join(repo, 'inner');
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(inner, '.git'), 'not a pointer\n');

      const result = await service.findWorkTree(inner);

      expect(result?.root).toBe(normalize(repo));
    });

    it('returns null for a relative cwd', async () => {
      await expect(findGitWorkTree(new HostFileSystem(), 'some/relative/path')).resolves.toBeNull();
    });
  });
});

describe('GitService repository mutation queue', () => {
  it('serializes mutations from sibling workspaces that share one repository root', async () => {
    const disposables = new DisposableStore();
    let releaseFirst: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let addStarts = 0;
    const hostProcess: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: async (_command, args) => {
        if (args?.[0] === 'rev-parse' && args[2] === '--git-common-dir') {
          return fakeProcess('/repo/.git\n', async () => 0);
        }
        if (args?.[0] === 'add') {
          addStarts += 1;
          if (addStarts === 1) {
            signalStarted?.();
            return fakeProcess('', async () => {
              await firstReleased;
              return 0;
            });
          }
          return fakeProcess('', async () => 0);
        }
        throw new Error(`unexpected git command: ${args?.join(' ')}`);
      },
    };
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IHostProcessService, hostProcess);
        reg.definePartialInstance(IHostFileSystem, {});
        reg.define(IGitService, GitService);
      },
    });

    try {
      const service = ix.get(IGitService);
      const first = service.stage('/repo/packages/one', ['a.txt']);
      const second = service.stage('/repo/packages/two', ['b.txt']);

      await firstStarted;
      expect(addStarts).toBe(1);
      releaseFirst?.();
      await Promise.all([first, second]);
      expect(addStarts).toBe(2);
    } finally {
      disposables.dispose();
    }
  });
});
