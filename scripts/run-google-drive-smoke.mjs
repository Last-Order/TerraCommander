import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import electronPath from 'electron';
import { build } from 'vite';

// The harness has its own bundle and profile; it never loads the renderer.
const outputDirectory = resolve('node_modules/.cache/google-drive-smoke');
await build({
  configFile: false,
  mode: 'development',
  build: {
    ssr: 'scripts/google-drive-accounts-smoke.ts',
    target: 'node24',
    outDir: outputDirectory,
    emptyOutDir: true,
    rollupOptions: {
      external: ['electron', 'electron-store', 'google-auth-library', 'electron-log/main'],
      output: { entryFileNames: 'main.mjs' },
    },
  },
});

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronPath,
  [resolve(outputDirectory, 'main.mjs'), ...process.argv.slice(2)],
  {
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  },
);
child.once('error', () => {
  process.stderr.write('Could not start the Electron account smoke harness.\n');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
