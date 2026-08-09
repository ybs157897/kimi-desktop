/**
 * Desktop-owned expert-team package compiler and lifecycle facade.
 *
 * Canonical packages live under `<KIMI_CODE_HOME>/experts`; the engine only
 * sees the standard Kimi plugin produced here. No renderer filesystem access
 * and no expert-team REST surface are needed.
 */

import { watch, type FSWatcher } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  EXPERT_TEAM_COLORS,
  type ExpertTeamDraft,
  type ExpertTeamRecord,
  type ExpertTeamStatus,
} from '../shared/expertTeams';

const TEAM_FILE = 'expert-team.json';
const MANIFEST_FILE = 'kimi.plugin.json';

const roleSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  prompt: z.string().trim().min(1),
  toolPreset: z.enum(['full', 'read-only']),
});

export const expertTeamDraftSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    color: z.enum(EXPERT_TEAM_COLORS),
    lead: roleSchema,
    members: z.array(roleSchema).min(1).max(16),
    quickPrompts: z.array(z.string().trim().min(1).max(500)).max(8),
  })
  .superRefine((value, context) => {
    const ids = [value.lead.id, ...value.members.map((member) => member.id)];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: 'custom',
        message: '专家角色 ID 不能重复',
        path: ['members'],
      });
    }
  });

export interface ExpertPluginSummary {
  readonly id: string;
  readonly enabled: boolean;
  readonly state: 'ok' | 'error';
  readonly originalSource?: string;
}

export interface ExpertPluginAdapter {
  list(): Promise<readonly ExpertPluginSummary[]>;
  install(source: string): Promise<ExpertPluginSummary>;
  setEnabled(input: {
    readonly id: string;
    readonly enabled: boolean;
  }): Promise<void>;
  remove(id: string): Promise<void>;
}

export class ExpertTeamService {
  private readonly root: string;
  private watcher: FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    kimiHomeDir: string,
    private readonly plugins: ExpertPluginAdapter | undefined,
  ) {
    this.root = join(kimiHomeDir, 'experts');
  }

  async initialize(managerPluginRoot?: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (this.plugins === undefined) return;
    if (managerPluginRoot !== undefined)
      await this.plugins.install(managerPluginRoot);
    for (const draft of await this.readDrafts()) {
      await this.plugins.install(this.packagePath(draft.id));
    }
    this.watcher = watch(this.root, { recursive: true }, () => {
      this.scheduleSync();
    });
  }

  dispose(): void {
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
    this.watcher?.close();
  }

  status(): ExpertTeamStatus {
    return { runtimeAvailable: this.plugins !== undefined };
  }

  async list(): Promise<readonly ExpertTeamRecord[]> {
    const installed = new Map(
      ((await this.plugins?.list()) ?? []).map(
        (plugin) => [plugin.id, plugin] as const,
      ),
    );
    const records: ExpertTeamRecord[] = [];
    for (const draft of await this.readDrafts()) {
      const pluginId = pluginIdFor(draft.id);
      const plugin = installed.get(pluginId);
      records.push({
        ...draft,
        pluginId,
        command: `/expert-${draft.id}`,
        enabled: plugin?.enabled ?? false,
        installed: plugin !== undefined,
        runtimeAvailable: this.plugins !== undefined,
        error: plugin?.state === 'error' ? '专家包加载失败' : undefined,
      });
    }
    return records.toSorted((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-CN'),
    );
  }

  async save(input: ExpertTeamDraft): Promise<ExpertTeamRecord> {
    const draft = expertTeamDraftSchema.parse(input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(join(this.root, '.expert-team-'));
    try {
      await writePackage(temporary, draft);
      const target = this.packagePath(draft.id);
      const backup = `${target}.backup`;
      await rm(backup, { recursive: true, force: true });
      let hadPrevious = false;
      try {
        await rename(target, backup);
        hadPrevious = true;
      } catch {
        // New package.
      }
      try {
        await rename(temporary, target);
        if (this.plugins !== undefined) await this.plugins.install(target);
        await rm(backup, { recursive: true, force: true });
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (hadPrevious) await rename(backup, target);
        throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    const record = (await this.list()).find((team) => team.id === draft.id);
    if (record === undefined)
      throw new Error(`专家团 ${draft.id} 保存后未找到`);
    return record;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const normalized = teamIdSchema.parse(id);
    if (this.plugins === undefined)
      throw new Error('附着模式暂不支持即时启停专家团');
    const pluginId = pluginIdFor(normalized);
    const installed = (await this.plugins.list()).some(
      (plugin) => plugin.id === pluginId,
    );
    if (!installed) await this.plugins.install(this.packagePath(normalized));
    await this.plugins.setEnabled({ id: pluginId, enabled });
  }

  async remove(id: string): Promise<string> {
    const normalized = teamIdSchema.parse(id);
    const pluginId = pluginIdFor(normalized);
    if (this.plugins !== undefined) {
      const installed = (await this.plugins.list()).some(
        (plugin) => plugin.id === pluginId,
      );
      if (installed) await this.plugins.remove(pluginId);
    }
    return this.packagePath(normalized);
  }

  private async readDrafts(): Promise<ExpertTeamDraft[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const drafts: ExpertTeamDraft[] = [];
    for (const entry of entries.toSorted()) {
      if (entry.startsWith('.')) continue;
      try {
        const raw = JSON.parse(
          await readFile(join(this.root, entry, TEAM_FILE), 'utf8'),
        );
        drafts.push(expertTeamDraftSchema.parse(raw));
      } catch {
        // Ignore unrelated or incomplete packages. We never import WorkBuddy state.
      }
    }
    return drafts;
  }

  private packagePath(id: string): string {
    return join(this.root, teamIdSchema.parse(id));
  }

  private scheduleSync(): void {
    if (this.plugins === undefined) return;
    if (this.watchTimer !== undefined) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = undefined;
      this.syncQueue = this.syncQueue
        .catch(() => undefined)
        .then(async () => {
          for (const draft of await this.readDrafts()) {
            await this.plugins?.install(this.packagePath(draft.id));
          }
        });
      void this.syncQueue.catch(() => undefined);
    }, 350);
  }
}

const teamIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function pluginIdFor(id: string): string {
  return `expert-team-${id}`;
}

function profileName(teamId: string, roleId: string): string {
  return `expert-${teamId}-${roleId}`;
}

async function writePackage(
  root: string,
  draft: ExpertTeamDraft,
): Promise<void> {
  const agentsDir = join(root, 'agents');
  const skillsDir = join(root, 'skills', `expert-${draft.id}`);
  await Promise.all([
    mkdir(agentsDir, { recursive: true, mode: 0o700 }),
    mkdir(skillsDir, { recursive: true, mode: 0o700 }),
  ]);

  const leadName = profileName(draft.id, draft.lead.id);
  const members = draft.members.map((member) =>
    profileName(draft.id, member.id),
  );
  const metadata = {
    schemaVersion: 1,
    kind: 'expert-team',
    id: draft.id,
    displayName: draft.displayName,
    color: draft.color,
    lead: leadName,
    members,
    quickPrompts: draft.quickPrompts,
  };
  const manifest = {
    name: pluginIdFor(draft.id),
    version: '1.0.0',
    description: draft.description,
    agents: './agents',
    skills: './skills',
    interface: {
      displayName: draft.displayName,
      shortDescription: draft.description,
      developerName: 'Kimi Code Desktop',
    },
    'x-kimi-desktop': metadata,
  };

  await Promise.all([
    writeFile(join(root, TEAM_FILE), `${JSON.stringify(draft, null, 2)}\n`, {
      mode: 0o600,
    }),
    writeFile(
      join(root, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      join(agentsDir, `${draft.lead.id}.md`),
      renderAgent(draft.id, draft.color, draft.lead, members, true),
      { mode: 0o600 },
    ),
    ...draft.members.map((member) =>
      writeFile(
        join(agentsDir, `${member.id}.md`),
        renderAgent(draft.id, draft.color, member, [], false),
        {
          mode: 0o600,
        },
      ),
    ),
    writeFile(
      join(skillsDir, 'SKILL.md'),
      renderActivationSkill(draft, leadName),
      {
        mode: 0o600,
      },
    ),
  ]);
}

function renderAgent(
  teamId: string,
  color: ExpertTeamDraft['color'],
  role: ExpertTeamDraft['lead'],
  subagents: readonly string[],
  lead: boolean,
): string {
  const tools = lead
    ? [
        'Agent',
        'AgentSwarm',
        'Read',
        'Glob',
        'Grep',
        'Skill',
        'AskUserQuestion',
      ]
    : role.toolPreset === 'read-only'
      ? ['Read', 'ReadMediaFile', 'Glob', 'Grep', 'WebSearch', 'FetchURL']
      : [
          'Read',
          'ReadMediaFile',
          'Glob',
          'Grep',
          'Edit',
          'Write',
          'Bash',
          'Skill',
          'WebSearch',
          'FetchURL',
        ];
  const frontmatter = [
    '---',
    `name: ${profileName(teamId, role.id)}`,
    `description: ${yamlString(role.description)}`,
    `color: ${color}`,
    `tools: [${tools.join(', ')}]`,
    ...(subagents.length > 0 ? [`subagents: [${subagents.join(', ')}]`] : []),
    '---',
    '',
  ];
  return `${frontmatter.join('\n')}${role.prompt.trim()}\n`;
}

function renderActivationSkill(
  draft: ExpertTeamDraft,
  leadName: string,
): string {
  return `---\nname: expert-${draft.id}\ndescription: ${yamlString(`使用${draft.displayName}处理需要多位专家协作的任务`)}\n---\n\n你正在激活「${draft.displayName}」。\n\n用户的原始任务：\n\n$ARGUMENTS\n\n必须立即调用 \`Agent\` 工具，将完整原始任务交给 \`${leadName}\`。不要在主 Agent 中模拟团员；等待团长完成分派和汇总后，再把团长的最终结果交付给用户。\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
