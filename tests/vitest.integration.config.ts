import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    globalSetup: ['integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    // Test files share one Postgres and one Redis; each file uses its own organizations and users.
    fileParallelism: false,
  },
});
