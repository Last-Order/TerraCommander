import type { AccountSummary } from '../../../../shared/accounts';
import type { OperationContext } from '../../../storage/core/contracts';
import type { GoogleDriveCredentials } from './credentials';
import type { GoogleAccountRepository } from './account-repository';
import { accountError, assertNotCancelled, AccountError } from '../../core/errors';
import { requireDriveScope, type GoogleAccountRecord, type SavedCredentials } from './models';
import { waitForAccountOperation } from '../../core/operations';
import type { GoogleAccountGateway, GoogleTokenSet } from './ports';

interface TokenSession {
  controller: AbortController;
  authorization: AccountSummary['authorization'];
  credentials: AccountSummary['credentials'];
  cached?: { value: string; expiresAt: number };
  refresh?: Promise<string>;
}

interface TokenProviderOptions {
  repository: GoogleAccountRepository;
  credentials: GoogleDriveCredentials;
  gateway: GoogleAccountGateway;
  now: () => number;
}

/** Account lifetimes own refreshes; individual callers only own their wait for a result. */
export class GoogleTokenProvider {
  private readonly sessions = new Map<string, TokenSession>();
  private readonly blockedAccounts = new Map<string, Set<symbol>>();
  private isDisposed = false;

  constructor(private readonly options: TokenProviderOptions) {}

  status(id: string): Pick<AccountSummary, 'authorization' | 'credentials'> {
    const session = this.sessions.get(id);
    return {
      authorization: session?.authorization ?? 'unchecked',
      credentials: session?.credentials ?? 'unchecked',
    };
  }

  async getAccessToken(id: string, ctx: OperationContext = {}): Promise<string> {
    this.assertAccountUsable(id);
    assertNotCancelled(ctx.signal);
    const record = this.options.repository.get(id);
    if (record.oauthClientId !== this.options.gateway.clientId) {
      throw new AccountError('ClientConfigurationInvalid');
    }
    const session = this.session(id);
    if (session.authorization === 'reauthorization-required') {
      throw new AccountError('AuthRequired');
    }
    if (session.cached && session.cached.expiresAt > this.options.now() + 60_000) {
      return session.cached.value;
    }

    if (!session.refresh) {
      const pending = this.refresh(record, session);
      session.refresh = pending;
      // A caller may cancel its wait before a transport finishes. Always observe the
      // shared promise, and do not let an old completion clear a replacement refresh.
      void pending
        .finally(() => {
          if (session.refresh === pending) delete session.refresh;
        })
        .catch(() => undefined);
    }
    return waitForAccountOperation(session.refresh, ctx.signal);
  }

  accept(record: GoogleAccountRecord, tokens: GoogleTokenSet): void {
    this.invalidate(record.id);
    const session = this.session(record.id);
    session.authorization = 'authorized';
    session.credentials = 'available';
    session.cached = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
  }

  requireReauthorization(id: string): void {
    this.invalidate(id);
    const session = this.session(id);
    session.authorization = 'reauthorization-required';
    session.credentials = 'available';
  }

  invalidate(id: string): void {
    this.sessions.get(id)?.controller.abort();
    this.sessions.delete(id);
  }

  block(id: string): () => void {
    const owners = this.blockedAccounts.get(id) ?? new Set<symbol>();
    const owner = Symbol();
    owners.add(owner);
    this.blockedAccounts.set(id, owners);
    const previous = this.status(id);
    this.invalidate(id);
    this.sessions.set(id, { controller: new AbortController(), ...previous });
    // Reauthorization and removal can overlap. Each operation releases only its
    // own block, so a cancelled login cannot reopen an account being removed.
    return () => {
      owners.delete(owner);
      if (owners.size === 0) this.blockedAccounts.delete(id);
    };
  }

  dispose(): void {
    this.isDisposed = true;
    for (const session of this.sessions.values()) session.controller.abort();
    this.sessions.clear();
  }

  private session(id: string): TokenSession {
    this.assertAccountUsable(id);
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        controller: new AbortController(),
        authorization: 'unchecked',
        credentials: 'unchecked',
      };
      this.sessions.set(id, session);
    }
    return session;
  }

  assertAccountUsable(id: string): void {
    if (this.isDisposed || this.blockedAccounts.has(id)) throw new AccountError('Cancelled');
  }

  private async refresh(original: GoogleAccountRecord, session: TokenSession): Promise<string> {
    const ctx: OperationContext = { signal: session.controller.signal };
    let record = original;
    try {
      const opened = await this.options.credentials.decrypt(record, ctx);
      session.credentials = 'available';
      if (
        opened.credentials.refreshExpiresAt !== undefined &&
        opened.credentials.refreshExpiresAt <= this.options.now()
      ) {
        throw new AccountError('AuthRequired');
      }
      if (opened.needsReEncryption) {
        record = await this.saveCredentials(record, opened.credentials, ctx);
      }

      const tokens = await waitForAccountOperation(
        this.options.gateway.refresh(opened.credentials.refreshToken, record.subject, ctx),
        ctx.signal,
      );
      assertNotCancelled(ctx.signal);
      if (!tokens.accessToken || tokens.expiresAt <= this.options.now()) {
        throw new AccountError('InvalidResponse');
      }
      const scopes = tokens.grantedScopes ?? record.grantedScopes;
      requireDriveScope(scopes);
      const credentials = mergeRefreshCredentials(opened.credentials, tokens);
      const changed =
        tokens.refreshToken !== undefined ||
        tokens.refreshExpiresAt !== undefined ||
        tokens.grantedScopes !== undefined;
      if (changed) {
        record = await this.saveCredentials({ ...record, grantedScopes: scopes }, credentials, ctx);
      }

      assertNotCancelled(ctx.signal);
      session.authorization = 'authorized';
      session.cached = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
      return tokens.accessToken;
    } catch (error) {
      const failure = accountError(error, ctx.signal);
      if (failure.code === 'CredentialStoreUnavailable') session.credentials = 'unavailable';
      if (['AuthRequired', 'InsufficientScope', 'IdentityMismatch'].includes(failure.code)) {
        session.authorization = 'reauthorization-required';
        delete session.cached;
      }
      throw failure;
    }
  }

  private async saveCredentials(
    record: GoogleAccountRecord,
    credentials: SavedCredentials,
    ctx: OperationContext,
  ) {
    const encrypted = await this.options.credentials.encrypt(record, credentials, ctx);
    const updated: GoogleAccountRecord = {
      ...record,
      encryptedCredentials: encrypted,
      updatedAt: new Date(this.options.now()).toISOString(),
      revision: record.revision + 1,
    };
    await this.options.repository.save(updated, record.revision, ctx);
    return updated;
  }
}

/** A new refresh token has its own lifetime; do not carry an older token's expiry onto it. */
export function mergeRefreshCredentials(
  previous: SavedCredentials,
  tokens: GoogleTokenSet,
): SavedCredentials {
  const rotated =
    tokens.refreshToken !== undefined && tokens.refreshToken !== previous.refreshToken;
  return {
    ...previous,
    refreshToken: tokens.refreshToken ?? previous.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt ?? (rotated ? undefined : previous.refreshExpiresAt),
  };
}
