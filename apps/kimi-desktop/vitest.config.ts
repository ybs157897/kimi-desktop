import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kimi-desktop',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
