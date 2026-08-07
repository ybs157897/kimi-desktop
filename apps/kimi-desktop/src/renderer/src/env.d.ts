/// <reference types="vite/client" />

import type { KimiDesktopBridge } from '../../shared/connection';

declare global {
  interface Window {
    /** Exposed by the preload script via contextBridge. */
    readonly kimiDesktop: KimiDesktopBridge;
  }
}
