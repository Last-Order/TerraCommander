# TerraCommander

## Product Positioning

TerraCommander is a desktop file manager for local files, cloud accounts, and remote storage. It provides unified browsing, file operations, cross-provider transfers, folder synchronization, scheduled backups, cross-account search, sharing, and encryption. It supports multiple accounts per provider and protocols including S3, FTP, SFTP, and WebDAV.

Implement features only when requested. Keep `README.md` empty unless explicitly instructed otherwise.

## Technology Stack

Use `package.json` and `package-lock.json` as the source of truth for dependency versions.

| Area                    | Technology                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Development environment | Node.js 24 (at least 24.15), npm 11                                                |
| Package management      | npm and `package-lock.json`; do not use pnpm or Yarn                               |
| Desktop runtime         | Electron 45                                                                        |
| Build tooling           | electron-vite 6, Vite 8, `@vitejs/plugin-react`                                    |
| Language                | TypeScript 7 with strict type checking and ES Modules                              |
| Frontend                | React 19, React DOM 19                                                             |
| UI                      | Mantine 9: core, hooks, notifications                                              |
| Styling                 | CSS Modules (`*.module.css`), PostCSS, postcss-preset-mantine, postcss-simple-vars |
| Icons                   | lucide-react                                                                       |
| State management        | Zustand 5                                                                          |
| Data validation         | Zod 4                                                                              |
| Local persistence       | electron-store 12                                                                  |
| Logging                 | electron-log 5                                                                     |
| Google Drive accounts   | google-auth-library 11                                                             |
| Linting                 | Oxlint and oxlint-tsgolint with type-aware linting                                 |
| Formatting              | Oxfmt                                                                              |
| Testing                 | Vitest 5, React Testing Library, jsdom                                             |
| Packaging               | electron-builder 26; Windows x64 NSIS installer and portable executable            |

Mantine Provider is configured, with theme customization in `src/renderer/src/app/theme.ts`. Zustand and notifications remain reserved for future features. Account management and storage access are separate backend modules, with provider-specific behavior behind common contracts. See `docs/account-management.md` and `docs/storage-abstraction.md` for their designs.

## Directory Structure and Boundaries

- `src/main/`: Electron main process, window lifecycle, logging, IPC, and sender validation.
- `src/main/services/`: Application-service ownership, on-demand initialization, and disposal.
- `src/main/accounts/`: Provider-neutral account management and platform-specific authentication.
- `src/main/storage/`: Provider-neutral storage access and adapter contracts.
- `src/preload/`: Restricted desktop APIs exposed through `contextBridge`.
- `src/shared/`: API types and communication channels shared by the main and renderer processes.
- `src/renderer/src/app/`: Blank React entry point, Mantine Provider, and theme configuration.
- `src/renderer/src/styles/`: Minimal global styles; use CSS Modules for component styles.
- `src/renderer/src/testing/`: Renderer test environment configuration.

Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Implement system capabilities in the main process and expose specific methods through preload. Validate senders and input when adding IPC handlers.

Keep common account and storage layers independent of provider SDKs. Authentication and file operations remain separate responsibilities. Reading account metadata must not initialize provider integrations; credentials remain in the backend.

## Common Commands

```sh
npm ci                 # Install locked dependencies
npm run dev            # Start development with renderer HMR and main/preload watching
npm run check          # Run formatting checks, linting, tests, and the build
npm run build          # Type-check and build for production into out/
npm run pack           # Create an unpacked application directory
npm run dist           # Create Windows installer and portable packages in dist/
```

Documentation-only changes do not require a full build. For code changes, run checks appropriate to the affected functionality.
