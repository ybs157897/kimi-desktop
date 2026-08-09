export const DESKTOP_TITLEBAR_HEIGHT = 36;

interface DesktopWindowChrome {
  readonly titleBarStyle: 'hidden' | 'hiddenInset' | undefined;
  readonly titleBarOverlay:
    | {
        readonly color: string;
        readonly symbolColor: string;
        readonly height: number;
      }
    | undefined;
  readonly autoHideMenuBar: boolean;
  readonly hideMenuBar: boolean;
}

export function resolveDesktopWindowChrome(
  platform: string,
): DesktopWindowChrome {
  const isMac = platform === 'darwin';
  const isWindows = platform === 'win32';
  return {
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : undefined,
    titleBarOverlay: isWindows
      ? {
          color: '#00000000',
          symbolColor: '#7c7c7c',
          height: DESKTOP_TITLEBAR_HEIGHT,
        }
      : undefined,
    autoHideMenuBar: isWindows,
    hideMenuBar: isWindows,
  };
}
