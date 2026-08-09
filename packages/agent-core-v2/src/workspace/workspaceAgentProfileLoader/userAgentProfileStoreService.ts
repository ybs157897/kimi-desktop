/**
 * `workspaceAgentProfileLoader` domain — `IUserAgentProfileStore` implementation.
 *
 * Persists user-level agent Markdown files through `hostFs`, resolves their
 * canonical roots through `bootstrap`, and prevents collisions with builtin
 * profiles through `agentProfileCatalog`. Existing unknown frontmatter fields
 * survive edits. Bound at App scope.
 */

import { dump as dumpYaml } from 'js-yaml';
import { join } from 'pathe';

import { LifecycleScope } from '#/app/scopes';

import { parseFrontmatter } from '#/_base/text/frontmatter';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { AgentFileParseError, parseAgentFileText } from './internal/agentFile';
import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { userAgentRoots } from './internal/agentRoots';
import type { AgentFileDefinition } from './internal/types';
import {
  IUserAgentProfileStore,
  type UserAgentProfileInput,
  type UserAgentProfileRecord,
  type UserAgentProfileUpdate,
} from './userAgentProfileStore';

const encoder = new TextEncoder();

export class UserAgentProfileStoreService implements IUserAgentProfileStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IBuiltinAgentProfileLoader private readonly builtin: IBuiltinAgentProfileLoader,
  ) {}

  async list(): Promise<readonly UserAgentProfileRecord[]> {
    const roots = await this.roots();
    const result = await discoverAgentFiles(this.fs, roots);
    return Promise.all(
      result.agents.map(async (definition) => ({
        ...recordFromDefinition(definition),
        editable: await this.isEditable(definition.path, roots.map((root) => root.path)),
      })),
    );
  }

  async create(input: UserAgentProfileInput): Promise<UserAgentProfileRecord> {
    if (this.builtin.list().some((profile) => profile.name === input.name)) {
      throw new AgentFileParseError(`Agent name "${input.name}" is reserved by a builtin profile`);
    }
    if ((await this.list()).some((profile) => profile.name === input.name)) {
      throw new AgentFileParseError(`User agent "${input.name}" already exists`);
    }

    const root = join(this.bootstrap.homeDir, 'agents');
    await this.fs.mkdir(root, { recursive: true });
    const path = join(root, `${input.name}.md`);
    const text = serializeAgentFile({}, input, input.prompt);
    const definition = parseAgentFileText({ path, source: 'user', text });
    if (!(await this.fs.createExclusive(path, encoder.encode(text)))) {
      throw new AgentFileParseError(`User agent file already exists: ${path}`);
    }
    return { ...recordFromDefinition(definition), editable: true };
  }

  async replace(name: string, input: UserAgentProfileUpdate): Promise<UserAgentProfileRecord> {
    const current = await this.requireEditable(name);
    const text = await this.fs.readText(current.path);
    const nextText = serializeAgentFile(
      requireFrontmatter(text, current.path),
      { ...input, name, color: input.color ?? current.color, enabled: current.enabled },
      input.prompt,
    );
    const definition = parseAgentFileText({ path: current.path, source: 'user', text: nextText });
    if (definition.name !== name) {
      throw new AgentFileParseError('User agent names cannot be changed while editing');
    }
    await this.fs.writeText(current.path, nextText);
    return { ...recordFromDefinition(definition), editable: true };
  }

  async setEnabled(name: string, enabled: boolean): Promise<UserAgentProfileRecord> {
    const current = await this.requireEditable(name);
    const text = await this.fs.readText(current.path);
    const frontmatter = requireFrontmatter(text, current.path);
    const nextText = serializeAgentFile(
      { ...frontmatter, enabled },
      {
        name: current.name,
        description: current.description,
        whenToUse: current.whenToUse,
        color: current.color,
        tools: current.tools,
        disallowedTools: current.disallowedTools,
        subagents: current.subagents,
        prompt: current.prompt,
        enabled,
      },
      current.prompt,
    );
    const definition = parseAgentFileText({ path: current.path, source: 'user', text: nextText });
    await this.fs.writeText(current.path, nextText);
    return { ...recordFromDefinition(definition), editable: true };
  }

  async remove(name: string): Promise<void> {
    const current = await this.requireEditable(name);
    await this.fs.remove(current.path);
  }

  private async requireEditable(name: string): Promise<UserAgentProfileRecord> {
    const profile = (await this.list()).find((candidate) => candidate.name === name);
    if (profile === undefined) {
      throw new AgentFileParseError(`User agent "${name}" does not exist`);
    }
    if (!profile.editable) {
      throw new AgentFileParseError(`User agent "${name}" is outside an editable user root`);
    }
    return profile;
  }

  private roots() {
    return userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
    );
  }

  private async isEditable(path: string, roots: readonly string[]): Promise<boolean> {
    const resolved = normalizePath(await this.fs.realpath(path));
    return roots.some((root) => isPathInside(resolved, normalizePath(root)));
  }
}

function recordFromDefinition(definition: AgentFileDefinition): Omit<UserAgentProfileRecord, 'editable'> {
  return {
    name: definition.name,
    description: definition.description,
    whenToUse: definition.whenToUse,
    color: definition.color,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    prompt: definition.prompt,
    enabled: definition.enabled,
    path: definition.path,
  };
}

function requireFrontmatter(text: string, path: string): Record<string, unknown> {
  const parsed = parseFrontmatter(text).data;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentFileParseError(`Frontmatter in ${path} must be a mapping at the top level`);
  }
  return parsed as Record<string, unknown>;
}

function serializeAgentFile(
  original: Record<string, unknown>,
  input: UserAgentProfileInput | (UserAgentProfileUpdate & { name: string; enabled: boolean }),
  prompt: string,
): string {
  const frontmatter: Record<string, unknown> = {
    ...original,
    name: input.name,
    description: input.description,
    enabled: input.enabled,
  };
  setOptional(frontmatter, 'whenToUse', input.whenToUse);
  setOptional(frontmatter, 'color', input.color);
  setOptional(frontmatter, 'tools', input.tools);
  setOptional(frontmatter, 'disallowedTools', input.disallowedTools);
  setOptional(frontmatter, 'subagents', input.subagents);
  return `---\n${dumpYaml(frontmatter, { lineWidth: -1, noRefs: true }).trimEnd()}\n---\n\n${prompt.trim()}\n`;
}

function setOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/$/, '');
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

registerScopedService(
  LifecycleScope.App,
  IUserAgentProfileStore,
  UserAgentProfileStoreService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileLoader',
);
