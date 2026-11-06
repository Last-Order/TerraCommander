# Account Management

The main process exposes one account API across providers. Each provider owns its authentication methods and private data. Shared infrastructure owns account metadata, encrypted credential binding, lazy provider initialization, and routing. Google Drive is the only production account provider implemented. File-operation adapters, frontend screens, and account IPC remain separate work.

## Public Backend API

```ts
const runtime = await services.accounts.get(context.signal);
const providers = runtime.accounts.listProviders();
const saved = await runtime.accounts.list();
const account = await runtime.accounts.add('google-drive', { method: 'browser' }, context);
await runtime.accounts.verify(account.id, context);
await runtime.accounts.updateAuthentication(account.id, { method: 'browser' }, context);
await runtime.accounts.remove(account.id, context);
```

`list(provider?)` returns safe common summaries: account ID, provider ID, optional labels, in-memory authorization/credential state, and the latest check. It never returns configuration, private provider data, credential references, tokens, or SDK objects. Restored accounts begin unchecked until explicitly used. `listProviders()` returns static descriptors and authentication capabilities without constructing providers.

Authentication requests select a provider-defined method and optional JSON data. A provider may describe browser authentication, supplied credentials, or no authentication. The manager checks the advertised method and operation capabilities before loading the provider. Each provider validates its own input; setup data may contain secrets and stays in the backend. Unsupported operations fail explicitly.

## Identity and Credentials

Every account receives a stable UUID and credential reference. Deduplication uses `(provider, identityKey)`; the identity key is opaque to common infrastructure. Email and display names are optional mutable labels. Different providers may use the same remote identity key without colliding, and one provider can own many accounts.

An account record contains immutable connection configuration, versioned nonsecret `providerData`, timestamps, a revision, and optional encrypted credentials. Providers define the meaning of their identity, configuration, and private payload. A secretless provider can omit encrypted credentials. The common layer contains no OAuth token schema, scope requirements, or provider SDK types.

`CredentialStore` encrypts provider-specific JSON through the OS-backed cipher. Its envelope binds the payload to the provider, account ID, identity key, credential reference, and immutable connection fingerprint. Moving ciphertext to another account or connection fails validation. Providers validate the decrypted private payload and handle any required re-encryption. Plaintext credentials are never written to the account snapshot.

`AccountRepository` is the sole snapshot writer. It validates records and uniqueness, serializes writes, and checks revisions before replacing metadata and ciphertext atomically in `accounts.json`. Failed writes leave the last committed in-memory state intact. Unsupported or corrupt snapshots fail without being cleared. The application profile lock protects single-writer ownership. This is the current format and API; there are no legacy readers, aliases, or migrations.

## Storage Integration

`runtime.accounts.getConnectionDefinition(id)` projects the backend connection ID, provider ID, immutable configuration, and credential reference. Updating credentials retains this definition; changing the remote identity or endpoint requires a new account. Removing and adding an account allocates new IDs.

`runtime.credentials` implements the storage `CredentialResolver` port. It looks up the reference, loads only its provider, and returns that provider's backend authorization handle as `unknown`. A future adapter narrows and validates its handle. The common layer does not assume every handle is an OAuth access token. Account failures become storage failures at this boundary.

## Initialization and Removal

There are two independent lazy boundaries. `ApplicationServices.accounts.get()` opens shared account infrastructure. `AccountProviderRegistry.get(providerId)` initializes only a provider needed for authentication, verification, or credential resolution. Ordinary startup does neither. Metadata listing opens the shared snapshot but loads no provider SDK and reads no provider client configuration.

Concurrent first callers share initialization; canceling one waiter does not cancel other waiters. A failed provider initialization can be retried by a later explicit operation and does not block other providers or metadata listing. Shutdown aborts active operations, disposes initialized providers once, and flushes pending repository writes. See [lazy service initialization](lazy-service-initialization.md).

Removal cancels account operations and pending additions for the same provider to prevent a late login from recreating a removed identity. A loaded provider also cancels its own token/authentication work. An unloaded or unavailable provider's record can be deleted locally without loading its SDK or requiring valid client configuration. Providers must respect cancellation before committing results and revalidate account existence when reusing credential handles.

## Code Layout and Extension

```text
src/shared/accounts/                  Serializable metadata and safe failures
src/main/accounts/
  core/                               Manager, provider registry, credential routing, ports
  persistence/                        Repository and encrypted credential envelope
  infrastructure/                     Electron store and safeStorage bindings
  providers/google-drive/             Google lifecycle, token handling, private data codecs
    oauth/                            Client configuration, SDK gateway, browser callback flow
    testing/                          Google-specific fakes
  runtime/                            Shared composition and deferred desktop factories
  testing/                            Common fakes and a synthetic key-based provider
```

To add a provider, implement `AccountProvider`, supply an SDK-free descriptor and deferred factory, and validate its setup/private data inside its own directory. Use shared persistence and encryption rather than creating another account-store writer. `getState()` must read memory only. Do not import a provider from `core/` or `persistence/`.

Tests cover independent key-based providers, provider-scoped identities, secret binding, metadata-only restoration, capability gating, initialization failure isolation, unavailable-provider removal, and removal/loading races. Google-specific lifecycle and OAuth tests remain with the Google provider. The synthetic provider is test infrastructure, not an S3 or local-storage implementation.
