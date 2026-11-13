# TerraCommander

## Product Positioning

TerraCommander is a desktop file manager for local files, cloud accounts, and remote storage. Its product scope includes unified browsing, file operations, cross-provider transfers, folder synchronization, scheduled backups, cross-account search, sharing, encryption, and multiple accounts per provider. Target integrations include S3, FTP, SFTP, and WebDAV. This describes product direction; available features and protocols are determined by their implementations.

Implement features only when requested. Keep `README.md` empty unless explicitly instructed otherwise.

## Technology and Tooling

Use [package.json](package.json) and [package-lock.json](package-lock.json) as the source of truth for dependencies and versions. Follow `engines` and `packageManager` for the development environment. Use npm; do not use pnpm or Yarn.

- Use Electron, electron-vite, and strict TypeScript with ES Modules.
- Build renderer UI with React and Mantine. Use CSS Modules (`*.module.css`) for component styles and lucide-react for icons. Theme customization belongs in [theme.ts](src/renderer/src/app/theme.ts).
- Use the existing validation, persistence, logging, state, and testing libraries when applicable. Installed dependencies do not imply that a feature should be implemented.
- Use the repository's Oxlint and Oxfmt configuration for linting and formatting.

## Module Boundaries

- `src/main/`: Electron lifecycle, logging, IPC, and sender validation.
- `src/main/services/`: Application-service ownership, composition, on-demand initialization, and disposal.
- `src/main/accounts/`: Provider-neutral account management and provider-owned authentication.
- `src/main/storage/`: Provider-neutral storage access and provider adapters.
- `src/preload/`: Restricted desktop APIs exposed through `contextBridge`.
- `src/shared/`: Serializable API contracts and communication channels shared across processes.
- `src/renderer/src/`: React UI, application theme, and renderer-owned state. Keep global styles minimal.

Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. Implement system capabilities in the main process and expose specific methods through preload. Validate senders and input when adding IPC handlers.

Keep common account and storage layers independent of provider SDKs. Authentication and file operations remain separate responsibilities. Reading account metadata must not initialize provider integrations; credentials remain in the backend.

## Documentation

Keep documentation focused on design rationale, architectural boundaries, ownership, and long-term constraints. Do not document concrete implementation logic or implemented feature behavior, including UI interactions, execution flows, internal algorithms, parameter values, API inventories, registrations, or detailed file layouts. Code and tests are the source of truth for these details; link to them when needed instead of maintaining a prose copy. Do not add feature-status snapshots, completed implementation plans, or test inventories. Keep development setup and verification procedures in their dedicated development documents.

Each topic has one primary document; reference it rather than repeating its rules:

- [Account management](docs/account-management.md): Common account identity, persistence, credentials, and provider extension.
- [Storage abstraction](docs/storage-abstraction.md): Storage semantics, capabilities, streams, and upload recovery.
- [Lazy service initialization](docs/lazy-service-initialization.md): Shared initialization, cancellation, and disposal.
- [Google Drive accounts](docs/google-drive-accounts.md): Google-specific authorization and identity rules.
- [Google Drive development](docs/google-drive-development.md): Client configuration and smoke-test procedures.
- [Task queue](docs/task-queue.md): Session ownership, scheduling, conflicts, and UI integration.

Update the primary document only when a change affects a design decision, ownership boundary, long-term constraint, or documented development procedure. Adding or changing a feature or UI behavior does not by itself justify a documentation update. Keep temporary plans and historical delivery scope out of current architecture guidance.

## Development Commands

Use the scripts in [package.json](package.json) for command definitions:

```sh
npm ci                 # Install locked dependencies
npm run dev            # Start development
npm run check          # Run the repository checks
npm run build          # Build for production
npm run pack           # Create an unpacked application
npm run dist           # Create release packages
```

Documentation-only changes require formatting and reference checks, not a full build. For code changes, run checks appropriate to the affected functionality.
