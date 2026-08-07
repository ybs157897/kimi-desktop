/**
 * Preload script — the only privileged surface of the renderer.
 *
 * Exposes `window.kimiDesktop.getConnection()` (one IPC invoke that resolves
 * the attach-mode connection facts in the main process), plus two narrow
 * main-process capabilities the renderer cannot reach itself: reading a
 * clipboard image (for paste-to-attach) and opening URLs in the system
 * browser. Nothing else leaks across the bridge: HTTP/WS traffic to the
 * kap-server runs inside the renderer with the returned bearer token, like
 * any web client.
 */

import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_GET_CONNECTION_CHANNEL,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL,
  type DesktopConnectionInfo,
} from '../shared/connection';

contextBridge.exposeInMainWorld('kimiDesktop', {
  getConnection: (): Promise<DesktopConnectionInfo | null> =>
    ipcRenderer.invoke(DESKTOP_GET_CONNECTION_CHANNEL),
  readClipboardImage: (): Promise<string | null> =>
    ipcRenderer.invoke(DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(DESKTOP_OPEN_EXTERNAL_CHANNEL, url),
});
