import { z } from 'zod';
import { AccountError } from '../../core/errors';
import { parseAccountData, type AccountRecord, type CredentialBinding } from '../../core/models';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_DRIVE_SCOPES = ['openid', 'email', DRIVE_SCOPE] as const;
const identifier = z.string().min(1).max(1024);

const googleRecordSchema = z.strictObject({
  id: z.uuid(),
  subject: identifier,
  oauthClientId: identifier,
  credentialRef: z.uuid(),
  email: z.string().max(1024).optional(),
  displayName: z.string().max(1024).optional(),
  grantedScopes: z.array(identifier),
  encryptedCredentials: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const savedCredentialsSchema = z.strictObject({
  version: z.literal(1),
  subject: identifier,
  oauthClientId: identifier,
  credentialRef: z.uuid(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number().finite().positive().optional(),
});

export type GoogleAccountRecord = z.infer<typeof googleRecordSchema>;
export type SavedCredentials = z.infer<typeof savedCredentialsSchema>;

export function requireDriveScope(scopes: readonly string[]): void {
  if (!scopes.includes(DRIVE_SCOPE)) throw new AccountError('InsufficientScope');
}

export function googleIdentityKey(subject: string, clientId: string): string {
  return JSON.stringify([subject, clientId]);
}

export function googleCredentialBinding(
  record: Pick<GoogleAccountRecord, 'id' | 'subject' | 'oauthClientId' | 'credentialRef'>,
): CredentialBinding {
  return {
    id: record.id,
    provider: 'google-drive',
    identityKey: googleIdentityKey(record.subject, record.oauthClientId),
    configuration: { subject: record.subject, oauthClientId: record.oauthClientId },
    credentialRef: record.credentialRef,
  };
}

export function encodeGoogleAccount(record: GoogleAccountRecord): AccountRecord {
  const { subject: _subject, oauthClientId: _client, grantedScopes, ...common } = record;
  return {
    ...common,
    ...googleCredentialBinding(record),
    providerData: { version: 1, payload: { grantedScopes: [...grantedScopes] } },
  };
}

export function decodeGoogleAccount(record: AccountRecord): GoogleAccountRecord {
  if (record.provider !== 'google-drive') throw new AccountError('NotFound');
  const configuration = parseAccountData(
    z.strictObject({ subject: identifier, oauthClientId: identifier }),
    record.configuration,
    'StoreInvalid',
  );
  const data = parseAccountData(
    z.strictObject({
      version: z.literal(1),
      payload: z.strictObject({ grantedScopes: z.array(identifier) }),
    }),
    record.providerData,
    'StoreInvalid',
  );
  if (
    record.identityKey !== googleIdentityKey(configuration.subject, configuration.oauthClientId)
  ) {
    throw new AccountError('StoreInvalid');
  }
  const {
    provider: _provider,
    identityKey: _identity,
    configuration: _configuration,
    providerData: _data,
    ...common
  } = record;
  return parseAccountData(
    googleRecordSchema,
    { ...common, ...configuration, grantedScopes: data.payload.grantedScopes },
    'StoreInvalid',
  );
}
