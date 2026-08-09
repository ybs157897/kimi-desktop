/**
 * Kimi Code Desktop — Electron main process.
 *
 * The default embedded mode owns an in-process kap-server for the Electron
 * lifetime. `--attach` (or `KIMI_CODE_DESKTOP_SERVER_MODE=attach`) instead
 * discovers the newest live local instance. The renderer receives only the
 * connection facts through preload, validates `GET /api/v1/meta`, and never
 * touches the filesystem.
 *
 * Window spec follows the desktop-app design doc: 1280×820, macOS
 * `titleBarStyle: 'hiddenInset'` + vibrancy, and a Windows controls overlay
 * that replaces the native title/menu bars with the renderer-owned header.
 */

import { BrowserWindow, Menu, app, clipboard, ipcMain, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { startServer } from '@moonshot-ai/kap-server';

import {
  DESKTOP_GET_CONNECTION_CHANNEL,
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL,
} from '../shared/connection';
import { resolveDesktopWindowChrome } from '../shared/windowChrome';
import {
  EXPERT_TEAM_LIST_CHANNEL,
  EXPERT_TEAM_REMOVE_CHANNEL,
  EXPERT_TEAM_SAVE_CHANNEL,
  EXPERT_TEAM_SET_ENABLED_CHANNEL,
  EXPERT_TEAM_STATUS_CHANNEL,
  type ExpertTeamDraft,
  type ExpertTeamSetEnabledInput,
} from '../shared/expertTeams';
import { ExpertTeamService } from './expertTeams';
import {
  findLiveServer,
  readServerToken,
  resolveDesktopHomeDir,
} from './serverDiscovery';
import {
  DesktopServerLifecycle,
  resolveDesktopServerMode,
} from './serverLifecycle';

// kap-server currently pulls in a few CommonJS libraries that inspect
// `require.cache` at runtime. The Electron main bundle is ESM, so provide the
// Node-compatible require those libraries expect while the server is bundled.
globalThis.require = createRequire(import.meta.url);

const APP_NAME = 'Kimi Code Desktop';
const PRELOAD_PATH = join(import.meta.dirname, '../preload/index.mjs');
const DEVELOPMENT_APP_ICON_PATH = join(app.getAppPath(), 'build', 'icon.png');

// Give Electron APIs the product name in development. The macOS host bundle is
// still Electron.app until packaging, so its Dock artwork is overridden below.
app.setName(APP_NAME);

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const chrome = resolveDesktopWindowChrome(process.platform);
  const bounds = readWindowBounds();
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    title: APP_NAME,
    icon: !app.isPackaged && !isMac ? DEVELOPMENT_APP_ICON_PATH : undefined,
    // macOS keeps its traffic lights over the renderer header. Windows uses
    // Window Controls Overlay: the native title strip disappears while the
    // standard minimize/maximize/close controls remain available at the top
    // right. The transparent overlay lets the renderer surface show through.
    titleBarStyle: chrome.titleBarStyle,
    titleBarOverlay: chrome.titleBarOverlay,
    vibrancy: isMac ? 'menu' : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    autoHideMenuBar: chrome.autoHideMenuBar,
    backgroundColor: '#181818',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // The preload script is bundled as ESM and needs `require`-free module
      // loading; unsandboxed preloads are required for ESM preload scripts.
      sandbox: false,
    },
  });

  // `autoHideMenuBar` alone does not hide a menu that is already visible.
  // Collapse it immediately on Windows; Alt still exposes the application
  // menu for keyboard users without reserving a permanent row in the layout.
  if (chrome.hideMenuBar) win.setMenuBarVisibility(false);

  // Persist bounds across moves/resizes so the window reopens where it was
  // last left. Debounced via the timer below.
  let saveTimer: NodeJS.Timeout | undefined;
  const saveBounds = (): void => {
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!win.isDestroyed()) writeWindowBounds(win.getNormalBounds());
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  win.once('ready-to-show', () => win.show());

  // electron-vite dev serves the renderer over HTTP; packaged builds load
  // the bundled file.
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl !== undefined && devUrl !== '') {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'right' });
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

const DESKTOP_HOME_DIR = resolveDesktopHomeDir();

// The embedded engine and bundled helper scripts still use KIMI_CODE_HOME for
// a few child-process paths. Scope it to this Electron process so every
// Desktop-owned artifact stays under the independent Desktop data directory.
process.env['KIMI_CODE_HOME'] = DESKTOP_HOME_DIR;

const WINDOW_BOUNDS_PATH = join(DESKTOP_HOME_DIR, 'desktop-window-bounds.json');

interface WindowBounds {
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_WINDOW: WindowBounds = {
  x: undefined,
  y: undefined,
  width: 1280,
  height: 820,
};

function readWindowBounds(): WindowBounds {
  try {
    const raw = readFileSync(WINDOW_BOUNDS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    return {
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      width:
        typeof parsed.width === 'number' && parsed.width >= 640
          ? parsed.width
          : DEFAULT_WINDOW.width,
      height:
        typeof parsed.height === 'number' && parsed.height >= 480
          ? parsed.height
          : DEFAULT_WINDOW.height,
    };
  } catch {
    return DEFAULT_WINDOW;
  }
}

function writeWindowBounds(bounds: Electron.Rectangle): void {
  try {
    writeFileSync(
      WINDOW_BOUNDS_PATH,
      JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }),
      { mode: 0o600 },
    );
  } catch {
    // best-effort persistence
  }
}

// NOTE: no top-level `await app.whenReady()` in this ESM entry — Electron
// delays the `ready` event until the main module finishes evaluating, so a
// top-level await on it deadlocks and no window ever appears.
const serverLifecycle = new DesktopServerLifecycle(
  {
    mode: resolveDesktopServerMode(),
    homeDir: DESKTOP_HOME_DIR,
    desktopVersion: app.getVersion(),
  },
  { startServer, findLiveServer, readServerToken },
);
let expertTeamService: ExpertTeamService | undefined;

void app.whenReady().then(async () => {
  // macOS ignores BrowserWindow.icon; development runs must override the Dock
  // icon explicitly because their host bundle is Electron.app. The packaged
  // app reads the same artwork from electron-builder's icon.icns instead.
  if (!app.isPackaged && process.platform === 'darwin') {
    app.dock?.setIcon(DEVELOPMENT_APP_ICON_PATH);
  }

  ipcMain.handle(DESKTOP_GET_CONNECTION_CHANNEL, () =>
    serverLifecycle.getConnection(),
  );

  // Clipboard image read for the composer's paste-to-attach (the renderer has
  // no clipboard access under contextIsolation). PNG data URL, or null when
  // the clipboard holds no image.
  ipcMain.handle(DESKTOP_READ_CLIPBOARD_IMAGE_CHANNEL, () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) return null;
    return image.toDataURL();
  });

  // Open a URL in the system browser. http/https only — anything else is
  // dropped before reaching shell.openExternal.
  ipcMain.handle(DESKTOP_OPEN_EXTERNAL_CHANNEL, (_event, url: unknown) => {
    if (typeof url !== 'string' || url === '') return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      void shell.openExternal(parsed.toString());
    } catch {
      // Invalid URL — ignore.
    }
  });

  try {
    await serverLifecycle.start();
  } catch (error) {
    console.error('[kimi-desktop] embedded server failed to start', error);
  }

  const klient = await serverLifecycle.getKlient();
  const expertTeams = new ExpertTeamService(
    DESKTOP_HOME_DIR,
    klient === undefined
      ? undefined
      : {
          list: () => klient.global.plugins.list(),
          install: (source) => klient.global.plugins.install(source),
          setEnabled: (input) => klient.global.plugins.setEnabled(input),
          remove: (id) => klient.global.plugins.remove(id),
        },
  );
  expertTeamService = expertTeams;
  const managerPluginRoot = app.isPackaged
    ? join(process.resourcesPath, 'expert-manager')
    : join(app.getAppPath(), 'resources', 'expert-manager');
  await expertTeams.initialize(managerPluginRoot).catch((error) => {
    console.error('[kimi-desktop] expert-team initialization failed', error);
  });
  ipcMain.handle(EXPERT_TEAM_STATUS_CHANNEL, () => expertTeams.status());
  ipcMain.handle(EXPERT_TEAM_LIST_CHANNEL, () => expertTeams.list());
  ipcMain.handle(EXPERT_TEAM_SAVE_CHANNEL, (_event, draft: ExpertTeamDraft) =>
    expertTeams.save(draft),
  );
  ipcMain.handle(
    EXPERT_TEAM_SET_ENABLED_CHANNEL,
    (_event, input: ExpertTeamSetEnabledInput) =>
      expertTeams.setEnabled(input.id, input.enabled),
  );
  ipcMain.handle(EXPERT_TEAM_REMOVE_CHANNEL, async (_event, id: string) => {
    const packagePath = await expertTeams.remove(id);
    await shell.trashItem(packagePath);
  });

  // Application menu: "New Window" lets multiple windows share one backend
  // (attach mode or the same embedded server). Mirrors the Codex multi-window
  // pattern; each window is an independent renderer over the same kap-server.
  const isMac = process.platform === 'darwin';
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        role: 'appMenu',
        submenu: [
        { role: 'about', label: 'About Kimi Code Desktop' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: isMac ? 'Hide Kimi Code' : 'Hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: isMac ? 'Quit Kimi Code' : 'Quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createWindow();
});

let readyToQuit = false;
app.on('before-quit', (event) => {
  if (readyToQuit) return;
  event.preventDefault();
  expertTeamService?.dispose();
  expertTeamService = undefined;
  void serverLifecycle
    .close()
    .catch((error: unknown) => {
      console.error(
        '[kimi-desktop] embedded server failed to close cleanly',
        error,
      );
    })
    .finally(() => {
      readyToQuit = true;
      app.quit();
    });
});

app.on('activate', () => {
  // macOS: re-create the window when the dock icon is clicked and no other
  // window is open.
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
