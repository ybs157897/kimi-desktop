/**
 * Local kap-server discovery for the main process — the attach-mode pendant of
 * kimi-inspect's `vite/serverDiscovery.ts` (same registry format, same liveness
 * probe; deliberately reimplemented here so the desktop app stays free of
 * server-side dependencies).
 *
 * kap-server self-registers for peer discovery
 * (`packages/kap-server/src/instanceRegistry.ts`):
 *   current builds  `<kimi home>/server/instances/<serverId>.json`
 * and persists the bearer token at `<kimi home>/server.token` (one token per
 * home, shared by every instance). The main process scans the registry, keeps
 * only pid-live entries, and picks the NEWEST heartbeat — the instance most
 * likely to still serve the UI (the CLI writes `heartbeat_at` every 15 s).
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Mirror of the on-disk instance file (`server_id` …, snake_case). */
interface ServerInstanceDisk {
  server_id?: string;
  pid?: number;
  host?: string;
  port?: number;
  started_at?: number;
  heartbeat_at?: number;
  host_version?: string;
}

/** A live, connectable instance as resolved by {@link findLiveServer}. */
export interface LiveServerInfo {
  readonly serverId: string;
  readonly host: string;
  readonly port: number;
  readonly hostVersion?: string;
}

export const KIMI_DESKTOP_HOME_ENV = 'KIMI_DESKTOP_HOME';

/** `KIMI_DESKTOP_HOME` env, else `~/.kimi-desktop`. */
export function resolveDesktopHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[KIMI_DESKTOP_HOME_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.kimi-desktop');
}

/** `process.kill(pid, 0)` probe — same semantics as the server's registry:
 * ESRCH = dead, EPERM/anything else = alive (never clobber a live entry). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Browser-reachable host: wildcard binds advertise as loopback. */
function normalizeHost(host: string | undefined): string {
  if (host === undefined || host === '' || host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }
  return host;
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Live instances under `<home>/server/instances`, newest heartbeat first. */
export async function readLiveInstances(
  homeDir: string,
): Promise<readonly LiveServerInfo[]> {
  const instancesDir = join(homeDir, 'server', 'instances');
  let names: string[];
  try {
    names = await readdir(instancesDir);
  } catch {
    return [];
  }
  const live: { recency: number; info: LiveServerInfo }[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const disk = await readJson<ServerInstanceDisk>(join(instancesDir, name));
        if (
          disk === undefined ||
          typeof disk.server_id !== 'string' ||
          typeof disk.pid !== 'number' ||
          typeof disk.port !== 'number' ||
          !pidAlive(disk.pid)
        ) {
          return;
        }
        live.push({
          // Newest heartbeat wins; instances without a heartbeat yet fall
          // back to their start time (registry entries created before the
          // heartbeat field was introduced).
          recency: Math.max(disk.heartbeat_at ?? 0, disk.started_at ?? 0),
          info: {
            serverId: disk.server_id,
            host: normalizeHost(disk.host),
            port: disk.port,
            hostVersion: typeof disk.host_version === 'string' ? disk.host_version : undefined,
          },
        });
      }),
  );
  live.sort((a, b) => b.recency - a.recency);
  return live.map((entry) => entry.info);
}

/**
 * The single instance to attach to: the live instance with the newest
 * heartbeat, or `null` when nothing is running. Callers that want the token
 * read it separately with {@link readServerToken} (same home dir).
 */
export async function findLiveServer(
  homeDir = resolveDesktopHomeDir(),
): Promise<LiveServerInfo | null> {
  const instances = await readLiveInstances(homeDir);
  return instances[0] ?? null;
}

/** The home-wide bearer token (`<home>/server.token`); undefined when absent/unreadable. */
export async function readServerToken(homeDir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(join(homeDir, 'server.token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}
