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
import {
  EXPERT_TEAM_LIST_CHANNEL,
  EXPERT_TEAM_REMOVE_CHANNEL,
  EXPERT_TEAM_SAVE_CHANNEL,
  EXPERT_TEAM_SET_ENABLED_CHANNEL,
  EXPERT_TEAM_STATUS_CHANNEL,
  type ExpertTeamDraft,
  type ExpertTeamRecord,
  type ExpertTeamSetEnabledInput,
  type ExpertTeamStatus,
} from '../shared/expertTeams';

contextBridge.exposeInMainWorld('kimiDesktop', {
  getConnection: (): Promise<DesktopConnectionInfo | null> =>
    ipcRenderer.invoke(DESKTOP_GET_CONNECTION_CHANNEL),
  readClipboardImage: (): Promise<string | null> =>
    ipcRenderer.invoke(DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(DESKTOP_OPEN_EXTERNAL_CHANNEL, url),
  expertTeams: {
    status: (): Promise<ExpertTeamStatus> =>
      ipcRenderer.invoke(EXPERT_TEAM_STATUS_CHANNEL),
    list: (): Promise<readonly ExpertTeamRecord[]> =>
      ipcRenderer.invoke(EXPERT_TEAM_LIST_CHANNEL),
    save: (draft: ExpertTeamDraft): Promise<ExpertTeamRecord> =>
      ipcRenderer.invoke(EXPERT_TEAM_SAVE_CHANNEL, draft),
    setEnabled: (input: ExpertTeamSetEnabledInput): Promise<void> =>
      ipcRenderer.invoke(EXPERT_TEAM_SET_ENABLED_CHANNEL, input),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke(EXPERT_TEAM_REMOVE_CHANNEL, id),
  },
});
