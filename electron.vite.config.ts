import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

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
      define: {
        __GOOGLE_DRIVE_OAUTH_CLIENT__: process.env.TERRACOMMANDER_GOOGLE_DRIVE_CLIENT_ID
          ? JSON.stringify({
              clientId: process.env.TERRACOMMANDER_GOOGLE_DRIVE_CLIENT_ID,
              ...(process.env.TERRACOMMANDER_GOOGLE_DRIVE_CLIENT_SECRET
                ? { clientSecret: process.env.TERRACOMMANDER_GOOGLE_DRIVE_CLIENT_SECRET }
                : {}),
            })
          : 'undefined',
      },
    },
    preload: {
      build: {
        externalizeDeps: false,
        isolatedEntries: true,
        rollupOptions: {
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      build: { minify: 'oxc' },
      resolve: {
        alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) },
      },
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
