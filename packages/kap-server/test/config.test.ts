import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configResponseSchema, type ConfigResponse } from '../src/protocol/rest-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-'));
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function boot(toml?: string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getConfig(): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  it('GET echoes default_permission_mode and derives yolo = false', async () => {
    await boot('default_permission_mode = "auto"\n');
    const cfg = await getConfig();
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);
  });

  it('POST { yolo: true } sets default_permission_mode = yolo and echoes yolo = true', async () => {
    await boot();
    const cfg = await patchConfig({ yolo: true });
    expect(cfg.default_permission_mode).toBe('yolo');
    expect(cfg.yolo).toBe(true);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('yolo');
    expect(after.yolo).toBe(true);
  });

  it('POST { default_permission_mode: auto } writes the canonical field and derives yolo = false', async () => {
    await boot();
    const cfg = await patchConfig({ default_permission_mode: 'auto' });
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('auto');
    expect(after.yolo).toBe(false);
  });

  it('POST secondary_model persists [secondary_model] and echoes it on GET', async () => {
    await boot();
    const cfg = await patchConfig({
      secondary_model: { model: 'k2-test', default_effort: 'high' },
    });
    expect(cfg.secondary_model).toEqual({ model: 'k2-test', defaultEffort: 'high' });

    const after = await getConfig();
    expect(after.secondary_model).toEqual({ model: 'k2-test', defaultEffort: 'high' });

    const toml = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(toml).toContain('[secondary_model]');
    expect(toml).toContain('model = "k2-test"');
    expect(toml).toContain('default_effort = "high"');
  });

  it('POST agent_models persists per-profile model bindings', async () => {
    await boot();
    const cfg = await patchConfig({
      agent_models: { coder: 'qwen/coder', explore: 'deepseek/flash' },
    });
    expect(cfg.agent_models).toEqual({ coder: 'qwen/coder', explore: 'deepseek/flash' });

    const after = await getConfig();
    expect(after.agent_models).toEqual({ coder: 'qwen/coder', explore: 'deepseek/flash' });

    const toml = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(toml).toContain('[agent_models]');
    expect(toml).toContain('coder = "qwen/coder"');
    expect(toml).toContain('explore = "deepseek/flash"');
  });

  it('POST agent_models removes bindings omitted from the replacement map', async () => {
    await boot('[agent_models]\ncoder = "qwen/coder"\nexplore = "deepseek/flash"\n');

    const replaced = await patchConfig({ agent_models: { explore: 'deepseek/pro' } });
    expect(replaced.agent_models).toEqual({ explore: 'deepseek/pro' });

    const after = await getConfig();
    expect(after.agent_models).toEqual({ explore: 'deepseek/pro' });

    const toml = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(toml).toContain('[agent_models]');
    expect(toml).toContain('explore = "deepseek/pro"');
    expect(toml).not.toContain('coder =');
  });

  it('GET agent-profiles returns builtin subagent profiles when no user files exist', async () => {
    await boot();
    const res = await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<{
      items: Array<{ name: string; source: string }>;
    }>;
    expect(body.code).toBe(0);
    expect(body.data.items.map((item) => item.name)).toEqual(['coder', 'explore', 'plan']);
    expect(body.data.items.every((item) => item.source === 'builtin')).toBe(true);
  });

  it('POST agent-profiles creates a user agent file that appears in the catalog', async () => {
    await boot();
    const res = await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'release-notes',
        description: 'Writes release notes',
        when_to_use: 'When preparing a release',
        color: 'violet',
        tools: ['Read', 'Grep'],
        prompt: 'Write concise release notes.',
        enabled: true,
      }),
    });
    const created = (await res.json()) as Envelope<{ name: string; source: string; color: string }>;
    expect(created.code).toBe(0);
    expect(created.data).toMatchObject({
      name: 'release-notes',
      source: 'user',
      color: 'violet',
    });

    const listRes = await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles');
    const list = (await listRes.json()) as Envelope<{
      items: Array<{ name: string; source: string }>;
    }>;
    expect(list.data.items).toContainEqual(
      expect.objectContaining({ name: 'release-notes', source: 'user' }),
    );
    expect(await readFile(join(home as string, 'agents', 'release-notes.md'), 'utf8'))
      .toContain('Write concise release notes.');
  });

  it('PUT agent-profiles updates editable user agent fields', async () => {
    await boot();
    await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'reviewer',
        description: 'Reviews code',
        prompt: 'Review code.',
      }),
    });

    const res = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/agent-profiles/reviewer',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: 'Reviews risky changes',
          when_to_use: 'Before merging',
          tools: ['Read'],
          prompt: 'Review the change carefully.',
        }),
      },
    );
    const updated = (await res.json()) as Envelope<{
      name: string;
      description: string;
      prompt: string;
    }>;
    expect(updated.code).toBe(0);
    expect(updated.data).toMatchObject({
      name: 'reviewer',
      description: 'Reviews risky changes',
      prompt: 'Review the change carefully.',
    });
  });

  it('POST agent profile state disables a user agent without removing its file', async () => {
    await boot();
    await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'triage',
        description: 'Triages issues',
        prompt: 'Triage the issue.',
      }),
    });

    const res = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/agent-profiles/triage/state',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    const disabled = (await res.json()) as Envelope<{ enabled: boolean; path: string }>;
    expect(disabled.code).toBe(0);
    expect(disabled.data.enabled).toBe(false);
    expect(await readFile(disabled.data.path, 'utf8')).toContain('enabled: false');
  });

  it('DELETE agent-profiles fully removes the user profile', async () => {
    await boot();
    await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'temporary-reviewer',
        description: 'Temporary reviewer',
        color: 'blue',
        prompt: 'Review once.',
      }),
    });
    const profilePath = join(home as string, 'agents', 'temporary-reviewer.md');

    const res = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/agent-profiles/temporary-reviewer',
      { method: 'DELETE' },
    );
    const deleted = (await res.json()) as Envelope<{ deleted: string }>;
    expect(deleted).toMatchObject({ code: 0, data: { deleted: 'temporary-reviewer' } });
    await expect(readFile(profilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const listRes = await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles');
    const list = (await listRes.json()) as Envelope<{ items: Array<{ name: string }> }>;
    expect(list.data.items.some((item) => item.name === 'temporary-reviewer')).toBe(false);
  });

  it('DELETE agent-profiles clears an exact model binding for the removed profile', async () => {
    await boot();
    await patchConfig({ agent_models: { reviewer: 'example/reviewer-model', coder: 'example/coder' } });
    await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'reviewer',
        description: 'Reviews code',
        prompt: 'Review carefully.',
      }),
    });

    await authedFetch(server as RunningServer, base, '/api/v1/agent-profiles/reviewer', {
      method: 'DELETE',
    });

    expect((await getConfig()).agent_models).toEqual({ coder: 'example/coder' });
  });

  it('GET hides the synthesized __secondary__ derived entry from models', async () => {
    await boot('[models.k2-test]\nprovider = "example"\nmodel = "example-model"\n');
    // `default_effort` is a patch field, so the overlay synthesizes the
    // `__secondary__` derived entry into the effective `models` view.
    const cfg = await patchConfig({
      secondary_model: { model: 'k2-test', default_effort: 'high' },
    });
    const models = cfg.models as Record<string, unknown>;
    expect(models['k2-test']).toBeDefined();
    expect(models['__secondary__']).toBeUndefined();

    const after = await getConfig();
    const afterModels = after.models as Record<string, unknown>;
    expect(afterModels['k2-test']).toBeDefined();
    expect(afterModels['__secondary__']).toBeUndefined();
  });
});
