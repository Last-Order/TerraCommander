import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Electron 45.1.0 ships these runtimes. Update the targets when upgrading Electron.
const electronNodeTarget = 'node24.22.1';
const electronChromiumTarget = 'chrome156';

export default defineConfig(({ command }) => {
  const development = command === 'serve';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${development ? ' ws://localhost:* ws://127.0.0.1:*' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');

  return {
    main: {
      resolve: { tsconfigPaths: true },
      build: { target: electronNodeTarget },
    },
    preload: {
      resolve: { tsconfigPaths: true },
      build: {
        target: electronNodeTarget,
        externalizeDeps: false,
        isolatedEntries: true,
        rollupOptions: {
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      build: { target: electronChromiumTarget, minify: 'oxc' },
      resolve: { tsconfigPaths: true },
      plugins: [
        react(),
        {
          name: 'terra-content-security-policy',
          transformIndexHtml: {
            order: 'pre',
            handler: (html) => html.replace('__CONTENT_SECURITY_POLICY__', csp),
          },
        },
      ],
    },
  };
});
