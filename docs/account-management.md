# Account Management

Account management owns saved identities, authentication lifecycles, and credential routing in the main process. Providers own their authentication methods and private data. File operations belong to the [storage layer](storage-abstraction.md); Google-specific rules belong to [Google Drive accounts](google-drive-accounts.md).

The [account manager](../src/main/accounts/core/account-manager.ts) defines the backend API, the [shared models](../src/shared/accounts/models.ts) define safe summaries and requests, and the [provider contract](../src/main/accounts/core/ports.ts) defines integration points. Use those definitions for exact signatures and fields.

## Metadata and Provider Isolation

Listing saved accounts reads common metadata and in-memory status without decrypting credentials, loading provider SDKs, reading provider client configuration, or contacting remote services. Restored authorization starts unchecked. A saved account alone does not establish valid authorization or connectivity.

Public summaries exclude connection configuration, private provider data, credential references, tokens, and SDK objects. Authentication setup data can contain secrets and must stay in the backend. Logs and cross-process failures expose safe categories rather than raw provider responses.

Provider descriptors declare authentication methods and operation capabilities without constructing a provider. The manager rejects unsupported requests before loading it; each provider validates its own setup and private payloads. Common infrastructure contains no provider SDK types, OAuth token schema, or provider-specific scope requirements.

## Identity and Persistence

An account has a stable application-generated identity and credential reference. Deduplication is scoped to a provider; the provider defines an opaque remote identity key. Mutable display labels must not determine identity. One provider can own multiple accounts, and identical remote keys from different providers must not collide.

Connection configuration is immutable. Refreshing credentials retains the connection identity; changing the remote identity or endpoint requires a new account. Removing and adding an account allocates new identifiers so stale references cannot attach to a replacement.

The [account repository](../src/main/accounts/persistence/account-repository.ts) is the sole snapshot writer. It validates records and uniqueness, serializes updates, checks revisions, and atomically replaces metadata and ciphertext together. Report success only after persistence completes. Failed writes preserve the last committed in-memory state; unsupported or corrupt snapshots fail without being cleared. The host's profile lock protects single-writer ownership.

Providers own versioned private metadata and credential payloads. Metadata stored outside encrypted payloads must be nonsecret. A provider that needs no secret may omit encrypted credentials. Persisted formats and validation are defined in the [backend models](../src/main/accounts/core/models.ts).

## Credentials and Storage Integration

The [credential store](../src/main/accounts/persistence/credential-store.ts) encrypts private payloads using an OS-backed cipher. The encrypted envelope binds a payload to its provider, account, remote identity, credential reference, and immutable connection fingerprint. Copying ciphertext to another account or connection must fail validation. Plaintext credentials must never enter the snapshot.

Providers validate decrypted payloads and handle required re-encryption through the shared repository. Encryption failure must not cause a plaintext fallback or automatic deletion of the saved account.

The manager projects backend connection definitions for storage use. The [credential resolver](../src/main/accounts/core/account-credential-resolver.ts) loads the required provider and returns its backend authorization handle. The consuming adapter validates that handle against its connection. Common infrastructure must not assume every handle is an OAuth access token. Account failures are translated into storage-domain failures at this boundary.

## Lifecycle and Extension

Use the application-owned runtime rather than creating another writer for the same profile. Shared runtime and provider initialization follow the [lazy service lifecycle](lazy-service-initialization.md).

Removal blocks new work for that account and cancels active operations, including pending additions for the same provider, so a late login cannot recreate a removed identity. Providers must observe cancellation before committing and revalidate account existence when a credential handle is reused. An unloaded or unavailable provider's local record remains removable without loading its SDK or requiring valid client configuration.

To add a provider, supply an SDK-free descriptor and deferred factory, implement the common provider contract, and validate setup and private data within its integration. Use shared persistence and encryption. Keep state inspection memory-only, and keep provider imports out of common account management and persistence.
