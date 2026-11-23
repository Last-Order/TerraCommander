import { AccountError } from '@main/accounts/core/errors';
import { parseAccountData } from '@main/accounts/core/models';
import type { CredentialStorePort } from '@main/accounts/core/ports';
import type { OperationContext } from '@main/common/operation-context';
import {
  googleCredentialBinding,
  savedCredentialsSchema,
  type GoogleAccountRecord,
  type SavedCredentials,
} from './models';

type GoogleCredentialBinding = Pick<
  GoogleAccountRecord,
  'id' | 'subject' | 'oauthClientId' | 'credentialRef'
>;

/** The common store protects account binding; this codec validates Google's private payload. */
export class GoogleDriveCredentials {
  constructor(private readonly store: CredentialStorePort) {}

  async encrypt(
    record: GoogleCredentialBinding,
    credentials: SavedCredentials,
    ctx: OperationContext,
  ): Promise<string> {
    const input = parseAccountData(
      savedCredentialsSchema,
      credentials,
      'CredentialStoreUnavailable',
    );
    return this.store.encrypt(
      googleCredentialBinding(record),
      {
        version: input.version,
        subject: input.subject,
        oauthClientId: input.oauthClientId,
        credentialRef: input.credentialRef,
        refreshToken: input.refreshToken,
        ...(input.refreshExpiresAt !== undefined
          ? { refreshExpiresAt: input.refreshExpiresAt }
          : {}),
      },
      ctx,
    );
  }

  async decrypt(record: GoogleAccountRecord, ctx: OperationContext) {
    const opened = await this.store.decrypt(
      googleCredentialBinding(record),
      record.encryptedCredentials,
      ctx,
    );
    const credentials = parseAccountData(
      savedCredentialsSchema,
      opened.payload,
      'CredentialStoreUnavailable',
    );
    if (
      credentials.subject !== record.subject ||
      credentials.oauthClientId !== record.oauthClientId ||
      credentials.credentialRef !== record.credentialRef
    ) {
      throw new AccountError('CredentialStoreUnavailable');
    }
    return { credentials, needsReEncryption: opened.needsReEncryption };
  }
}
