# Google Drive Accounts

Google Drive implements the common [account provider contract](account-management.md). This document owns Google-specific authorization, identity, and refresh guarantees. See [Google Drive development](google-drive-development.md) for client setup and live validation.

## Client and Permission Decisions

Use a public Desktop OAuth client and the system browser, with no hosted token intermediary. Embedded client configuration cannot serve as a confidential security boundary. Keep real client values and user credentials out of source control.

The requested identity scopes support binding and display. Full Drive authorization supports general file-manager access; a per-file grant does not cover that purpose. Validate the scopes actually granted before accepting an account. The [Google models](../src/main/accounts/providers/google-drive/models.ts) define exact scope requirements; Google's [scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) explains their meaning.

The [Google gateway](../src/main/accounts/providers/google-drive/oauth/google-sdk-gateway.ts) owns SDK types, token exchange, identity validation, refresh, and the Drive account probe. Keep those responsibilities inside the provider integration.

## Authorization Guarantees

The [authorization flow](../src/main/accounts/providers/google-drive/oauth/authorization-flow.ts) and [loopback receiver](../src/main/accounts/providers/google-drive/oauth/loopback-callback.ts) must preserve these guarantees:

- Serialize interactive authorization attempts and bound their lifetime with cancellation and a deadline. Existing accounts remain usable independently of another account's login.
- Bind the callback listener to loopback on an OS-assigned port before opening the browser. Use fresh PKCE S256 material, state, and an OIDC nonce for each attempt.
- Accept only the expected callback host, path, method, and unambiguous parameters. Validate state, reject replay, and complete once. Invalid or unrelated requests must not consume a legitimate attempt.
- Exchange the code with its verifier and exact redirect URI. Validate the ID token's signature, issuer, audience, expiry, and nonce before accepting its identity.
- Require a usable refresh token for persistence. An omitted refresh token may be recovered only from an eligible saved grant for the same verified subject and client.
- Complete the Drive account probe, encryption, and atomic save before reporting success. Cancellation must prevent late results from being committed.

Close listeners on every exit path. Callback pages use fixed self-contained text with no-store caching and never echo codes, tokens, or provider error bodies. See Google's [Desktop OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app).

## Identity and Authorization Handles

Use Google's verified subject and OAuth client ID as the provider's identity key. Email and display name are mutable labels. A repeated login for that identity updates the existing account; reauthorization of a selected account must retain its subject and client. Choosing another identity fails and preserves the original record.

Connection configuration binds the subject and client; labels, scopes, timestamps, and tokens do not belong in it. Client configuration changes must not silently rebind saved grants. My Drive and Shared Drives are spaces of one account connection, not separate login identities.

The [credential resolver](../src/main/accounts/providers/google-drive/credential-resolver.ts) returns a backend authorization handle bound to that connection. Storage adapters validate the binding before use. Each token request revalidates the saved account, so a stale handle cannot survive removal and re-addition. Refresh tokens and repository access stay private to the account integration.

Common encryption, atomic snapshot ownership, connection identity, and provider isolation follow [account management](account-management.md). Google additionally validates the subject/client binding in its private credential payload. Access tokens, ID tokens, authorization codes, PKCE verifiers, and pending login attempts remain in memory.

## Refresh, Checks, and Removal

The [token provider](../src/main/accounts/providers/google-drive/token-provider.ts) shares refresh work for one credential while allowing accounts to progress independently. Cancelling one waiter must not cancel work needed by others. Preserve a saved refresh token when no replacement is returned, and await persistence before accepting a replacement. SDK token events alone do not establish that a save completed.

An invalid grant requires reauthorization. Network failures, rate limits, disabled APIs, policy failures, and temporary credential-key unavailability retain their distinct meanings. Credential resolution never starts interactive login.

The account probe validates a limited Drive request. Success does not prove write access to every file or access to every Shared Drive. Initial add and reauthorization require a successful probe before saving their candidate grant. Failed reauthorization preserves the old record; later verification failure does not remove an existing account. The [provider lifecycle](../src/main/accounts/providers/google-drive/account-provider.ts) and [grant writer](../src/main/accounts/providers/google-drive/grant-writer.ts) own those commit boundaries.

Browser connectivity and backend connectivity are independent. Backend requests require cancellation and bounded timeouts. Retry only safe operations; do not blindly replay a possibly consumed authorization code or a file write after an uncertain response.

Local removal cancels work and invalidates token reuse so late refresh or authorization results cannot restore removed credentials. Removing an account from this installation does not revoke the Google project's grant. Grant revocation requires separate explicit product behavior; see Google's [revocation guidance](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

Before public distribution, review Google's [restricted-scope verification guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) and [refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration) for the project's publishing status. Validate real login and recovery with the intended release client.
