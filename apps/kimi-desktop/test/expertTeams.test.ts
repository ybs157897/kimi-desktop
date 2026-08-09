import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ExpertTeamService,
  expertTeamDraftSchema,
  type ExpertPluginAdapter,
  type ExpertPluginSummary,
} from '../src/main/expertTeams';
import type { ExpertTeamDraft } from '../src/shared/expertTeams';

let homeDir: string | undefined;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  if (homeDir !== undefined)
    await rm(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

describe('ExpertTeamService', () => {
  it('reports whether live plugin management is available', () => {
    expect(
      new ExpertTeamService('/tmp/kimi-desktop-experts', undefined).status(),
    ).toEqual({
      runtimeAvailable: false,
    });
    expect(
      new ExpertTeamService(
        '/tmp/kimi-desktop-experts',
        new MemoryPluginAdapter(),
      ).status(),
    ).toEqual({ runtimeAvailable: true });
  });

  it('compiles a team into standard Kimi agent and skill plugin resources', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-experts-'));
    const plugins = new MemoryPluginAdapter();
    const service = new ExpertTeamService(homeDir, plugins);

    const record = await service.save(EXPERT_TEAM_DRAFT);
    const packageRoot = join(homeDir, 'experts', EXPERT_TEAM_DRAFT.id);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, 'kimi.plugin.json'), 'utf8'),
    );
    const lead = await readFile(join(packageRoot, 'agents', 'lead.md'), 'utf8');
    const researcher = await readFile(
      join(packageRoot, 'agents', 'researcher.md'),
      'utf8',
    );
    const skill = await readFile(
      join(packageRoot, 'skills', 'expert-code-review', 'SKILL.md'),
      'utf8',
    );

    expect(record).toMatchObject({
      id: 'code-review',
      pluginId: 'expert-team-code-review',
      command: '/expert-code-review',
      enabled: true,
      installed: true,
      runtimeAvailable: true,
    });
    expect(manifest).toMatchObject({
      name: 'expert-team-code-review',
      agents: './agents',
      skills: './skills',
    });
    expect(lead).toContain('name: expert-code-review-lead');
    expect(lead).toContain('color: blue');
    expect(lead).toContain(
      'tools: [Agent, AgentSwarm, Read, Glob, Grep, Skill, AskUserQuestion]',
    );
    expect(lead).toContain(
      'subagents: [expert-code-review-researcher, expert-code-review-implementer]',
    );
    expect(researcher).toContain('name: expert-code-review-researcher');
    expect(researcher).not.toContain('Agent');
    expect(researcher).not.toContain('Edit');
    expect(skill).toContain('name: expert-code-review');
    expect(skill).toContain('`expert-code-review-lead`');
  });

  it('delegates enablement and removal through the plugin extension boundary', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-experts-'));
    const plugins = new MemoryPluginAdapter();
    const service = new ExpertTeamService(homeDir, plugins);

    await service.save(EXPERT_TEAM_DRAFT);
    await service.setEnabled(EXPERT_TEAM_DRAFT.id, false);

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: 'code-review', enabled: false }),
    ]);
    await expect(service.remove(EXPERT_TEAM_DRAFT.id)).resolves.toBe(
      join(homeDir, 'experts', 'code-review'),
    );
    expect(await plugins.list()).toEqual([]);
  });

  it('rejects duplicate role identifiers before writing a package', () => {
    expect(
      expertTeamDraftSchema.safeParse({
        ...EXPERT_TEAM_DRAFT,
        members: EXPERT_TEAM_DRAFT.members.map((member) => ({
          ...member,
          id: 'duplicate',
        })),
      }).success,
    ).toBe(false);
  });

  it('lets the bundled expert-manager helper create the same portable package shape', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-expertctl-'));
    const specPath = join(homeDir, 'spec.json');
    await writeFile(specPath, JSON.stringify(EXPERT_TEAM_DRAFT), 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(
          import.meta.dirname,
          '../resources/expert-manager/skills/expert-manager/scripts/expertctl.mjs',
        ),
        'save',
        specPath,
      ],
      { env: { ...process.env, KIMI_CODE_HOME: homeDir } },
    );
    const lead = await readFile(
      join(homeDir, 'experts', 'code-review', 'agents', 'lead.md'),
      'utf8',
    );

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      id: 'code-review',
      command: '/expert-code-review',
    });
    expect(lead).toContain('color: blue');
    expect(lead).toContain(
      'subagents: [expert-code-review-researcher, expert-code-review-implementer]',
    );
  });
});

class MemoryPluginAdapter implements ExpertPluginAdapter {
  private readonly plugins = new Map<string, ExpertPluginSummary>();

  async list(): Promise<readonly ExpertPluginSummary[]> {
    return [...this.plugins.values()];
  }

  async install(source: string): Promise<ExpertPluginSummary> {
    const id = `expert-team-${basename(source)}`;
    const summary: ExpertPluginSummary = {
      id,
      enabled: this.plugins.get(id)?.enabled ?? true,
      state: 'ok',
      originalSource: source,
    };
    this.plugins.set(id, summary);
    return summary;
  }

  async setEnabled(input: {
    readonly id: string;
    readonly enabled: boolean;
  }): Promise<void> {
    const existing = this.plugins.get(input.id);
    if (existing === undefined) throw new Error(`Unknown plugin ${input.id}`);
    this.plugins.set(input.id, { ...existing, enabled: input.enabled });
  }

  async remove(id: string): Promise<void> {
    this.plugins.delete(id);
  }
}

const EXPERT_TEAM_DRAFT: ExpertTeamDraft = {
  id: 'code-review',
  displayName: '代码评审专家团',
  description: '从多个专业视角评审代码并汇总结论。',
  color: 'blue',
  lead: {
    id: 'lead',
    displayName: '评审团长',
    description: '拆分评审任务并汇总成员结论。',
    prompt: '先拆分任务，再派发给成员，最后汇总有证据的结论。',
    toolPreset: 'full',
  },
  members: [
    {
      id: 'researcher',
      displayName: '安全专家',
      description: '只读检查安全风险。',
      prompt: '只读检查输入、权限和敏感数据处理风险。',
      toolPreset: 'read-only',
    },
    {
      id: 'implementer',
      displayName: '实现专家',
      description: '必要时修改代码。',
      prompt: '依据团长任务完成最小范围实现。',
      toolPreset: 'full',
    },
  ],
  quickPrompts: ['评审当前改动'],
};
