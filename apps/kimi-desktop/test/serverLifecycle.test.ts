/**
 * Desktop server lifecycle contract: embedded startup/teardown and explicit
 * attach discovery. Unit cases stub kap-server and filesystem discovery at
 * their process boundaries; one smoke case runs the real embedded server in
 * an isolated temporary home. Run with
 * `pnpm --filter @moonshot-ai/kimi-desktop test`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startServer as startKapServer, type ServerStartOptions } from '@moonshot-ai/kap-server';

import {
  DESKTOP_SERVER_MODE_ENV,
  DesktopServerLifecycle,
  resolveDesktopServerMode,
} from '../src/main/serverLifecycle';

const originalMode = process.env[DESKTOP_SERVER_MODE_ENV];
let realLifecycle: DesktopServerLifecycle | undefined;
let realHomeDir: string | undefined;

afterEach(async () => {
  await realLifecycle?.close();
  if (realHomeDir !== undefined) await rm(realHomeDir, { recursive: true, force: true });
  realLifecycle = undefined;
  realHomeDir = undefined;
  vi.restoreAllMocks();
  if (originalMode === undefined) delete process.env[DESKTOP_SERVER_MODE_ENV];
  else process.env[DESKTOP_SERVER_MODE_ENV] = originalMode;
});

function embeddedRig() {
  const close = vi.fn(async () => {});
  const startServer = vi.fn(async (_options: ServerStartOptions) => ({
    host: '127.0.0.1',
    port: 43123,
    authTokenService: { getToken: () => 'desktop-token' },
    close,
  }));
  const lifecycle = new DesktopServerLifecycle(
    { mode: 'embedded', homeDir: '/tmp/kimi-desktop-test', desktopVersion: '1.2.3' },
    {
      startServer,
      findLiveServer: vi.fn(async () => null),
      readServerToken: vi.fn(async () => undefined),
    },
  );
  return { lifecycle, startServer, close };
}

describe('desktop server lifecycle (owns embedded backend or discovers attach peer)', () => {
  it('returns the owned endpoint when embedded mode starts successfully', async () => {
    const { lifecycle, startServer } = embeddedRig();

    await lifecycle.start();
    const connection = await lifecycle.getConnection();

    expect(startServer).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 0,
      homeDir: '/tmp/kimi-desktop-test',
      hostIdentity: {
        productName: 'kimi-code-desktop',
        version: '1.2.3',
        platform: 'kimi_code_desktop',
      },
    });
    expect(connection).toEqual({
      mode: 'embedded',
      host: '127.0.0.1',
      port: 43123,
      token: 'desktop-token',
      serverId: 'embedded',
    });
  });

  it('closes the owned server once when shutdown is requested repeatedly', async () => {
    const { lifecycle, close } = embeddedRig();
    await lifecycle.start();

    await Promise.all([lifecycle.close(), lifecycle.close()]);

    expect(close).toHaveBeenCalledOnce();
  });

  it('returns the newest live peer when attach mode has a server and token', async () => {
    const startServer = vi.fn();
    const lifecycle = new DesktopServerLifecycle(
      { mode: 'attach', homeDir: '/tmp/kimi-desktop-test', desktopVersion: '1.2.3' },
      {
        startServer,
        findLiveServer: vi.fn(async () => ({
          serverId: 'peer-1',
          host: '127.0.0.1',
          port: 58627,
          hostVersion: '0.2.1',
        })),
        readServerToken: vi.fn(async () => 'peer-token'),
      },
    );

    const connection = await lifecycle.getConnection();

    expect(startServer).not.toHaveBeenCalled();
    expect(connection).toEqual({
      mode: 'attach',
      host: '127.0.0.1',
      port: 58627,
      token: 'peer-token',
      serverId: 'peer-1',
      version: '0.2.1',
    });
  });

  it('defaults to embedded mode when no explicit mode is configured', () => {
    delete process.env[DESKTOP_SERVER_MODE_ENV];

    expect(resolveDesktopServerMode(['electron'], process.env)).toBe('embedded');
  });

  it('selects attach mode when the command line requests it', () => {
    process.env[DESKTOP_SERVER_MODE_ENV] = 'embedded';

    expect(resolveDesktopServerMode(['electron', '--attach'], process.env)).toBe('attach');
  });

  it('serves v2 metadata while the real owned embedded backend is running', async () => {
    realHomeDir = await mkdtemp(join(tmpdir(), 'kimi-desktop-test-'));
    realLifecycle = new DesktopServerLifecycle(
      { mode: 'embedded', homeDir: realHomeDir, desktopVersion: '1.2.3' },
      {
        startServer: startKapServer,
        findLiveServer: vi.fn(async () => null),
        readServerToken: vi.fn(async () => undefined),
      },
    );

    const connection = await realLifecycle.getConnection();
    expect(connection).not.toBeNull();
    if (connection === null) return;

    const response = await fetch(`http://${connection.host}:${connection.port}/api/v1/meta`, {
      headers: { authorization: `Bearer ${connection.token}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      code: 0,
      data: { backend: 'v2' },
    });
  });
});
