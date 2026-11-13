# Google Drive Development

This guide covers Desktop OAuth client configuration and account smoke checks. Authorization guarantees belong to [Google Drive accounts](google-drive-accounts.md); common backend contracts belong to [account management](account-management.md).

## Client Configuration

Create a Google Cloud project, enable Drive API, configure its consent screen, and create an OAuth client of type **Desktop app**. Add the intended Google accounts as test users when using a project in Testing. Use separate projects and clients for development and production.

Copy [.env.example](../.env.example) to the appropriate local mode file and fill in the Desktop client settings described in the template:

```powershell
Copy-Item .env.example .env.development.local
# Fill in the development Desktop OAuth client before starting.
npm run dev
```

For releases, use `.env.production.local` with the production client, then run `npm run build` or `npm run dist`. The template defines the required client ID and optional Desktop client secret; [shared environment types](../src/shared/env.d.ts) define their code-facing names.

Client values use the shared `VITE_` build-configuration convention through `import.meta.env`. They are public configuration available to main and renderer. User access tokens and refresh tokens must never be placed in these variables. Keep real values in ignored local files.

Development and the smoke harness use development mode; release builds default to production mode. Mode-specific files override common files, and existing shell variables take precedence. Restart commands after editing environment files. Packaged applications use the values selected at build time and do not load local environment files or runtime Google client overrides. See [electron-vite environment modes](https://electron-vite.org/guide/env-and-mode).

Client configuration is validated when the Google provider is needed. Missing or invalid values must not block saved metadata listing; Google authentication and credential use report a configuration failure. Changing client IDs does not migrate existing grants.

## Backend Integration

Use the application-owned runtime and follow the [lazy service lifecycle](lazy-service-initialization.md). The [desktop account composition](../src/main/accounts/runtime/desktop-accounts.ts) binds persistence, encryption, and deferred providers. The [storage browser service](../src/main/services/storage-browser.ts) integrates accounts with desktop browsing; its renderer-facing operations are defined in the [shared browser API](../src/shared/storage-browser.ts).

## Smoke Checks

The [smoke harness](../scripts/google-drive-accounts-smoke.ts) runs in Electron without the renderer and uses a separate profile. Its [launcher](../scripts/run-google-drive-smoke.mjs) builds it with development-mode configuration. It prints safe summaries or error codes.

These checks require no Google client or network:

```sh
npm run smoke:google-drive -- idle
npm run smoke:google-drive -- infrastructure
```

`idle` constructs and disposes the service host without opening account infrastructure. `infrastructure` checks OS encryption and encrypted persistence with synthetic records in its own subdirectory.

For live validation, configure the development client first:

```sh
npm run smoke:google-drive -- add
npm run smoke:google-drive -- list
npm run smoke:google-drive -- verify <account-id>
npm run smoke:google-drive -- reauthorize <account-id>
npm run smoke:google-drive -- remove <account-id>
```

`add` and `reauthorize` open the system browser. Use the returned account ID in later commands. Listing in a fresh process checks restoration; verification after restart exercises refresh from the saved grant. Check account isolation with two identities and identity rejection by reauthorizing a selected record with another Google account.

`list` must also work without valid Google client configuration. Removal deletes this profile's local account; it does not revoke remote authorization. Set `TERRACOMMANDER_SMOKE_USER_DATA` to an absolute path to select another isolated profile directory. The harness holds a profile lock, and its infrastructure check does not modify live account records.

## Validation and Profiles

Use the scripts in [package.json](../package.json) for repository checks. Automated tests use fake provider responses and local loopback requests without real Google credentials. Callback integration tests require permission to connect to localhost. Live login and packaged-release validation require interactive consent with the intended project client.

Development, packaged releases, and the smoke harness keep separate user-data profiles; application profile selection is defined in the [main entry point](../src/main/index.ts). Account persistence follows the [common repository rules](account-management.md#identity-and-persistence). OS-backed credentials are tied to their encryption environment, so copying a profile across users or machines does not promise usable authorization.
