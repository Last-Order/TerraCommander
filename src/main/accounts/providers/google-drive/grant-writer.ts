import { randomUUID } from 'node:crypto';
import type { OperationContext } from '../../../storage/core/contracts';
import type { GoogleDriveCredentials } from './credentials';
import type { GoogleAccountRepository } from './account-repository';
import { AccountError } from '../../core/errors';
import type { GoogleAccountRecord, SavedCredentials } from './models';
import { waitForAccountOperation } from '../../core/operations';
import type { GoogleAccountGateway, GoogleAuthorizationGrant } from './ports';

interface GrantWriterOptions {
  repository: GoogleAccountRepository;
  credentials: GoogleDriveCredentials;
  gateway: GoogleAccountGateway;
  now: () => number;
}

interface AccountCandidate {
  grant: GoogleAuthorizationGrant;
  existing: GoogleAccountRecord | undefined;
  reuseRefreshToken: boolean;
}

/** A candidate is published only after its API check, encryption, and atomic save succeed. */
export class AccountGrantWriter {
  constructor(private readonly options: GrantWriterOptions) {}

  async save(candidate: AccountCandidate, ctx: OperationContext): Promise<GoogleAccountRecord> {
    const { grant, existing, reuseRefreshToken } = candidate;
    const clientId = this.options.gateway.clientId;
    if (!clientId) throw new AccountError('ClientConfigurationInvalid');
    const id = existing?.id ?? randomUUID();
    const credentialRef = existing?.credentialRef ?? randomUUID();
    let refreshToken = grant.refreshToken;
    let refreshExpiresAt = grant.refreshExpiresAt;
    if (!refreshToken && existing && reuseRefreshToken) {
      const saved = (await this.options.credentials.decrypt(existing, ctx)).credentials;
      refreshToken = saved.refreshToken;
      refreshExpiresAt = saved.refreshExpiresAt;
    }
    if (
      !refreshToken ||
      (refreshExpiresAt !== undefined && refreshExpiresAt <= this.options.now())
    ) {
      throw new AccountError('AuthRequired');
    }
    if (!grant.accessToken || grant.expiresAt <= this.options.now()) {
      throw new AccountError('InvalidResponse');
    }

    const profile = await waitForAccountOperation(
      this.options.gateway.check(grant.accessToken, ctx),
      ctx.signal,
    );
    const credentials: SavedCredentials = {
      version: 1,
      subject: grant.subject,
      oauthClientId: clientId,
      credentialRef,
      refreshToken,
      refreshExpiresAt,
    };
    const encrypted = await this.options.credentials.encrypt(
      { id, subject: grant.subject, oauthClientId: clientId, credentialRef },
      credentials,
      ctx,
    );
    const timestamp = new Date(this.options.now()).toISOString();
    const record: GoogleAccountRecord = {
      id,
      subject: credentials.subject,
      oauthClientId: clientId,
      credentialRef,
      email: profile.email ?? grant.email ?? existing?.email,
      displayName: profile.displayName ?? existing?.displayName,
      grantedScopes: [...grant.grantedScopes],
      encryptedCredentials: encrypted,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      revision: (existing?.revision ?? 0) + 1,
    };
    await this.options.repository.save(record, existing?.revision, ctx);
    return record;
  }
}
