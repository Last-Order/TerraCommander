import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    clearMocks: true,
    restoreMocks: true,
    projects: [
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: 'backend',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
      {
        resolve: { tsconfigPaths: true },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/renderer/src/testing/setup.ts'],
        },
      },
    ],
  },
});
