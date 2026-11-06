import type { OperationContext } from '../../../storage/core/contracts';
import type { CredentialStore } from '../../persistence/credential-store';
import { AccountError } from '../../core/errors';
import {
  googleCredentialBinding,
  savedCredentialsSchema,
  type GoogleAccountRecord,
  type SavedCredentials,
} from './models';
import { parseAccountData } from '../../core/models';

type GoogleCredentialBinding = Pick<
  GoogleAccountRecord,
  'id' | 'subject' | 'oauthClientId' | 'credentialRef'
>;

/** The common store protects account binding; this codec validates Google's private payload. */
export class GoogleDriveCredentials {
  constructor(private readonly store: CredentialStore) {}

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
