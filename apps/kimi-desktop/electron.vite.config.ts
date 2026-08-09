import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';

/**
 * electron-vite convention layout:
 *   src/main/index.ts        — main process (bundled ESM, out/main/index.js)
 *   src/preload/index.ts     — preload script (bundled ESM, out/preload/index.mjs)
 *   src/renderer/index.html  — renderer root (Vite dev server in dev; bundled
 *                              to out/renderer on build)
 * `"type": "module"` in package.json makes electron-vite emit ESM for main and
 * preload; the preload file always gets the `.mjs` extension, which is what
 * the main process references when attaching it to the BrowserWindow.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // linkedom treats canvas as an optional dependency and falls back to
        // its built-in shim when it is unavailable. Keep the require at
        // runtime so Rollup does not turn that fallback into a build-time
        // missing-module error.
        external: ['canvas'],
      },
      // kap-server exports TypeScript source inside the workspace. Bundle it
      // so packaged Electron never depends on Node loading decorators or
      // `?raw` prompt imports from workspace source at runtime.
      externalizeDeps: {
        exclude: [
          '@moonshot-ai/kap-server',
          '@moonshot-ai/klient',
          '@moonshot-ai/protocol',
          '@moonshot-ai/transcript',
        ],
      },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
