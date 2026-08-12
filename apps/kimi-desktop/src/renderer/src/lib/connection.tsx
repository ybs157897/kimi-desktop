/**
 * Connection context — owns the `ApiClient` for the embedded or attached
 * kap-server resolved by the Electron main process.
 *
 * Flow: `window.kimiDesktop.getConnection()` resolves `{mode, host, port,
 * token}` from the main-process lifecycle. With a connection in hand the
 * provider probes `GET /api/v1/meta` and requires `backend === 'v2'` (the
 * DI × Scope engine — the desktop data layer is built against its surface);
 * an older v1 backend or a dead server lands on a blocking error screen with
 * a retry, instead of silently degrading.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { ApiClient, ApiError } from './api';
import type { DesktopServerMode, KimiDesktopBridge } from '../../../shared/connection';

export interface ConnectionValue {
  /** Server base URL, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Bearer token from `<KIMI_DESKTOP_HOME>/server.token`. */
  readonly token: string;
  /** Instance registry id of the attached server. */
  readonly serverId: string;
  /** Version reported by `GET /api/v1/meta`. */
  readonly serverVersion: string;
  /** Whether Electron owns the backend or attaches to a peer. */
  readonly mode: DesktopServerMode;
  /** The REST client for this connection. */
  readonly api: ApiClient;
}

type ConnectionState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ready'; readonly value: ConnectionValue };

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConnectionState>({ kind: 'connecting' });
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => {
    setState({ kind: 'connecting' });
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'connecting' });
    void (async () => {
      let connection: Awaited<ReturnType<KimiDesktopBridge['getConnection']>>;
      try {
        connection = await window.kimiDesktop.getConnection();
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: `无法读取连接信息: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }
      if (connection === null) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message:
              '没有找到正在运行的 kimi-code 服务器。请先在终端运行 `kimi web`（开发环境为 `pnpm dev:server`），然后重试。',
          });
        }
        return;
      }
      const baseUrl = `http://${connection.host}:${connection.port}`;
      const api = new ApiClient(baseUrl, connection.token);
      let meta;
      try {
        meta = await api.meta();
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof ApiError
              ? `服务器校验失败 (${error.code}): ${error.message}`
              : `无法连接 ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`;
          setState({ kind: 'error', message });
        }
        return;
      }
      if (!cancelled) {
        if (meta.backend !== 'v2') {
          setState({
            kind: 'error',
            message: `服务器 ${baseUrl} 是 ${meta.backend ?? 'v1'} 引擎，desktop 需要 v2 引擎（backend === 'v2'）。请升级 kimi-code 后重试。`,
          });
          return;
        }
        setState({
          kind: 'ready',
          value: {
            baseUrl,
            token: connection.token,
            serverId: meta.server_id,
            serverVersion: meta.server_version,
            mode: connection.mode,
            api,
          },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const value = state.kind === 'ready' ? state.value : null;

  const rendered = useMemo(() => {
    switch (state.kind) {
      case 'connecting':
        return (
          <div className="flex h-screen items-center justify-center">
            <div className="text-[length:var(--client-content-font-size)] text-neutral-500">
              正在连接 kimi-code 服务器…
            </div>
          </div>
        );
      case 'error':
        return <ConnectionError message={state.message} onRetry={retry} />;
      case 'ready':
        return children;
    }
  }, [state, children, retry]);

  return <ConnectionContext.Provider value={value}>{rendered}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionValue {
  const value = useContext(ConnectionContext);
  if (value === null) {
    throw new Error('useConnection used before the connection is ready');
  }
  return value;
}

/** Blocking screen when no live server / wrong backend / unreachable server. */
function ConnectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="w-[520px] rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <h1 className="mb-1 text-lg font-semibold text-neutral-100">无法连接 kimi-code</h1>
        <p className="mb-4 whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">{message}</p>
        <button
          className="rounded bg-sky-600 px-3 py-1.5 text-[length:var(--client-content-font-size)] font-medium text-white hover:bg-sky-500"
          onClick={onRetry}
        >
          重试
        </button>
      </div>
    </div>
  );
}
