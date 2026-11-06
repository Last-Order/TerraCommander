# Google Drive Account Development

The backend implements account authorization and lifecycle management. The desktop renderer remains blank. The main process owns a lightweight application-service host; it does not expose account methods through IPC yet.

The [shared account runtime](account-management.md) opens on first account use. The [lazy service lifecycle](lazy-service-initialization.md) loads the Google Drive authentication module only when a Google login, verification, or credential request needs it. Ordinary startup opens no account store; listing metadata reads no Google client configuration and loads no Google SDK. Initialization errors affect the requested feature; a later explicit call can retry.

## Configuration

Create a Google Cloud project, enable Drive API, configure its consent screen, and create an OAuth client of type **Desktop app**. For a project in Testing, add the Google accounts used for live testing. The requested scopes are `openid`, `email`, and `https://www.googleapis.com/auth/drive`.

Both development and release builds use `VITE_GOOGLE_DRIVE_CLIENT_ID` and the optional `VITE_GOOGLE_DRIVE_CLIENT_SECRET`. Copy the root `.env.example` to the matching mode file and fill in that environment's Desktop OAuth client. Use separate Google Cloud projects and clients for development and production.

```powershell
Copy-Item .env.example .env.development.local
# Edit .env.development.local with your development Desktop OAuth client.
npm run dev
```

Use electron-vite's native `VITE_` prefix for shared build configuration. Main and renderer code read the same variables through `import.meta.env`, for example `import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID`. Vite loads and replaces these values automatically; new variables require no changes to `electron.vite.config.ts`. Shared environment types live in `src/shared/env.d.ts`. There is no custom `define` mapping, environment copying, or runtime override layer.

Commands read `.env`, `.env.local`, and their mode-specific variants from the project root. Development and the smoke harness use `development`; release builds use `production` by default. Mode-specific files override common files; existing shell variables take precedence at build time. Restart the command after editing an environment file. Local environment files are ignored by Git; `.env.example` contains empty placeholders only.

For release builds, copy `.env.example` to `.env.production.local` and set the same variable names to the production client's values, then run `npm run build` or `npm run dist`. Packaged applications use the values selected during the build; they do not load environment files or read runtime Google client overrides.

`VITE_` values are public build configuration available to main and renderer. The Desktop OAuth client configuration follows this convention; user access tokens and refresh tokens remain in backend memory or encrypted persistence. Keep real values out of source control; native Desktop clients rely on PKCE rather than confidentiality of an embedded client secret. See [electron-vite environment variables](https://electron-vite.org/guide/env-and-mode).

Without client configuration, the application still starts and saved account summaries remain readable. Login and credential use report `ClientConfigurationInvalid`. Changing client IDs never migrates existing grants implicitly.

## Backend Entry Points

- `src/main/accounts/index.ts`: generic account manager, provider contracts, shared factory, and safe errors.
- `src/main/accounts/runtime/desktop-accounts.ts`: Electron persistence, OS encryption, logging, and deferred provider registration.
- `src/main/accounts/providers/google-drive/create-provider.ts`: Google lifecycle composition using injected common services.
- `src/main/accounts/providers/google-drive/desktop-provider.ts`: deferred Google configuration, SDK, browser, and callback bindings.
- `src/main/accounts/providers/google-drive/credential-resolver.ts`: backend authorization handle and binding guard for future adapters.
- `src/main/services/application-services.ts`: typed lazy account-runtime access and application-owned disposal.
- `src/main/services/lazy-service.ts`: shared initialization, independent waiter cancellation, retry after failure, and shutdown races.
- `src/main/index.ts`: profile lock, lightweight service host, and shutdown disposal.
- `src/shared/accounts/`: provider-neutral summaries, descriptors, setup requests, check results, and failure codes.

Obtain the runtime from the host before calling an account API:

```ts
const runtime = await services.accounts.get(context.signal);
const accounts = await runtime.accounts.list('google-drive');
const added = await runtime.accounts.add('google-drive', { method: 'browser' }, context);
```

The common manager supports `list`, `listProviders`, `add`, `updateAuthentication`, `verify`, and `remove`. Google reauthorization uses `updateAuthentication(id, { method: 'browser' }, context)`. `getConnectionDefinition(id)` is a backend-only projection for a future adapter. Inject `runtime.credentials` into `AdapterRegistry` when that adapter exists. Use the host-owned instance and let the host dispose it; do not create a second writer for the same profile. Concurrent first callers share initialization; canceling a waiter does not cancel initialization needed by others.

Interactive methods accept `OperationContext.signal` for cancellation and have a five-minute deadline. Only one login attempt runs at a time. Regular verification and token refresh can run independently across accounts. SDK calls have a 30-second request timeout. Credentials never trigger an interactive login automatically.

## Opt-in Smoke Harness

The harness runs in Electron without loading the renderer and uses a separate **TerraCommander Account Smoke** profile. It prints only safe summaries or error codes. Its `infrastructure` command uses synthetic data to check the actual OS encryption API and encrypted persistence across repository reconstruction; it needs no Google client or network:

```sh
npm run smoke:google-drive -- infrastructure
```

To check the unused lifecycle, run `npm run smoke:google-drive -- idle`. This constructs and disposes the same application-service host without importing the account runtime or opening its store. A corrupt account snapshot or invalid OAuth configuration must not break this command. Account commands below use `services.accounts.get()`. `list` exercises only the shared runtime boundary and must succeed even with invalid Google client configuration; login and verification cross the additional provider boundary.

For a live account check, configure the development client variables first, then run:

```sh
npm run smoke:google-drive -- add
npm run smoke:google-drive -- list
npm run smoke:google-drive -- verify <account-id>
npm run smoke:google-drive -- reauthorize <account-id>
npm run smoke:google-drive -- remove <account-id>
```

`add` and `reauthorize` open the system browser. `list` after a fresh process verifies account restoration; `verify` after restarting exercises refresh from the saved grant. Add two Google accounts to check isolation. Reauthorize a selected record with another Google account to check identity rejection. Removal deletes only this profile's local grant; it does not revoke the Google project's authorization on other installations.

For an isolated test directory, set `TERRACOMMANDER_SMOKE_USER_DATA` to an absolute path. The harness holds a profile lock. Its `infrastructure-check` subdirectory contains synthetic records only; it does not modify live account records.

## Persistence and Validation

Development uses the **TerraCommander Development** user-data profile; installed releases use **TerraCommander**. The shared `accounts.json` snapshot combines account metadata with OS-encrypted credential envelopes in one atomic replacement. Account IDs and credential references remain stable through refresh and reauthorization. There is no reader or migration for the previous Google-only format. Access tokens and pending login state remain in memory. Copying profiles across Windows users or machines does not promise working credentials.

`npm run check` runs formatting, type-aware linting, tests, type checking, and the production build. Backend tests use fake Google responses and real local loopback requests; they never contact Google or require real credentials. A restricted execution environment must permit localhost connections for the callback integration tests.

Real Google login requires a configured project client and interactive consent. Public release verification and Google account-policy restrictions are described in the [account integration design](google-drive-accounts.md). This phase adds no Drive file operations or upload implementation.
