/**
 * Connection facts shared between the Electron main process (producer), the
 * preload bridge and the renderer type declaration (consumers). The renderer
 * never touches the filesystem itself — it asks the main process once via
 * `window.kimiDesktop.getConnection()` and then talks to the kap-server over
 * plain HTTP/WS with the returned bearer token.
 */

/** IPC channel name for `window.kimiDesktop.getConnection()`. */
export const DESKTOP_GET_CONNECTION_CHANNEL = 'kimi-desktop:get-connection';

/** IPC channel name for `window.kimiDesktop.readClipboardImage()`. */
export const DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL = 'kimi-desktop:read-clipboard-image';

/** IPC channel name for `window.kimiDesktop.openExternal()`. */
export const DESKTOP_OPEN_EXTERNAL_CHANNEL = 'kimi-desktop:open-external';

export type DesktopServerMode = 'embedded' | 'attach';

/** Connection facts for the embedded server or an attached live peer. */
export interface DesktopConnectionInfo {
  /** Whether Electron owns the server lifecycle or attaches to a peer. */
  readonly mode: DesktopServerMode;
  /** Loopback-normalized host (kap-server binds 127.0.0.1). */
  readonly host: string;
  readonly port: number;
  /** Bearer token read from `<KIMI_CODE_HOME>/server.token`. */
  readonly token: string;
  /** Instance registry id (`<serverId>.json`), e.g. 'local' or a uuid. */
  readonly serverId: string;
  /** `host_version` recorded in the instance file, when present. */
  readonly version?: string;
}

/** The `window.kimiDesktop` bridge surface exposed by the preload script. */
export interface KimiDesktopBridge {
  /**
   * Resolve the owned embedded server or the newest live attach-mode peer.
   * Resolves `null` after shutdown, or when attach mode cannot find a live
   * instance and token.
   */
  getConnection(): Promise<DesktopConnectionInfo | null>;
  /**
   * Read the system clipboard's image as a PNG data URL (for paste-to-attach
   * in the composer). Resolves `null` when the clipboard holds no image.
   */
  readClipboardImage(): Promise<string | null>;
  /**
   * Open a URL in the user's default browser (main-process
   * `shell.openExternal`; http/https only).
   */
  openExternal(url: string): Promise<void>;
}
