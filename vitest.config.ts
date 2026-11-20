import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    clearMocks: true,
    restoreMocks: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: { name: 'backend', include: ['src/{main,shared}/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'renderer', include: ['src/renderer/**/*.test.ts'] },
      },
    ],
  },
});
