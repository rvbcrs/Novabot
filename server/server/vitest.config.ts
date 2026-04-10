import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    // Each test file gets its own in-memory DB
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
