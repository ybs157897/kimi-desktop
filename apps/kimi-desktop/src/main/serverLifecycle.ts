/**
 * Kimi Code Desktop server lifecycle.
 *
 * Embedded mode owns one in-process kap-server from startup through Electron
 * shutdown. Attach mode owns no server and resolves the newest live peer each
 * time the renderer asks for connection facts.
 */

import type { ServerStartOptions } from '@moonshot-ai/kap-server';

import type { DesktopConnectionInfo, DesktopServerMode } from '../shared/connection';
import type { LiveServerInfo } from './serverDiscovery';

export const DESKTOP_SERVER_MODE_ENV = 'KIMI_CODE_DESKTOP_SERVER_MODE';

interface OwnedDesktopServer {
  readonly host: string;
  readonly port: number;
  readonly authTokenService: { getToken(): string };
  close(): Promise<void>;
}

interface DesktopServerLifecycleDependencies {
  readonly startServer: (options: ServerStartOptions) => Promise<OwnedDesktopServer>;
  readonly findLiveServer: (homeDir: string) => Promise<LiveServerInfo | null>;
  readonly readServerToken: (homeDir: string) => Promise<string | undefined>;
}

export interface DesktopServerLifecycleOptions {
  readonly mode: DesktopServerMode;
  readonly homeDir: string;
  readonly desktopVersion: string;
}

export function resolveDesktopServerMode(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): DesktopServerMode {
  if (argv.includes('--attach')) return 'attach';

  const configured = env[DESKTOP_SERVER_MODE_ENV];
  if (configured === undefined || configured === '' || configured === 'embedded') return 'embedded';
  if (configured === 'attach') return 'attach';
  throw new Error(`${DESKTOP_SERVER_MODE_ENV} must be "embedded" or "attach".`);
}

export class DesktopServerLifecycle {
  private serverPromise: Promise<OwnedDesktopServer> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: DesktopServerLifecycleOptions,
    private readonly dependencies: DesktopServerLifecycleDependencies,
  ) {}

  async start(): Promise<void> {
    if (this.options.mode === 'attach') return;
    if (this.closed) throw new Error('Desktop server lifecycle is already closed.');
    await this.embeddedServer();
  }

  async getConnection(): Promise<DesktopConnectionInfo | null> {
    if (this.closed) return null;
    if (this.options.mode === 'attach') return this.attachedConnection();

    const server = await this.embeddedServer();
    return {
      mode: 'embedded',
      host: server.host,
      port: server.port,
      token: server.authTokenService.getToken(),
      serverId: 'embedded',
    };
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeEmbeddedServer();
    return this.closePromise;
  }

  private embeddedServer(): Promise<OwnedDesktopServer> {
    this.serverPromise ??= this.dependencies.startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: this.options.homeDir,
      hostIdentity: {
        productName: 'kimi-code-desktop',
        version: this.options.desktopVersion,
        platform: 'kimi_code_desktop',
      },
    });
    return this.serverPromise;
  }

  private async attachedConnection(): Promise<DesktopConnectionInfo | null> {
    const [server, token] = await Promise.all([
      this.dependencies.findLiveServer(this.options.homeDir),
      this.dependencies.readServerToken(this.options.homeDir),
    ]);
    if (server === null || token === undefined) return null;
    return {
      mode: 'attach',
      host: server.host,
      port: server.port,
      token,
      serverId: server.serverId,
      version: server.hostVersion,
    };
  }

  private async closeEmbeddedServer(): Promise<void> {
    if (this.options.mode === 'attach' || this.serverPromise === undefined) return;
    let server: OwnedDesktopServer;
    try {
      server = await this.serverPromise;
    } catch {
      // A failed start already cleans up kap-server's partial boot resources.
      return;
    }
    await server.close();
  }
}
