import { z } from 'zod';
import type { AccountErrorCode } from '../../../shared/accounts';
import type { ConnectionDefinition } from '../../../shared/storage';
import { AccountError } from './errors';

const identifier = z.string().min(1).max(1024);
const configuration = z.record(z.string(), z.json());

/** Provider data is nonsecret metadata. Secrets belong in the encrypted credential envelope. */
export const accountRecordSchema = z.strictObject({
  id: z.uuid(),
  provider: identifier,
  identityKey: z.string().min(1).max(16_384),
  credentialRef: z.uuid(),
  configuration,
  providerData: z.strictObject({ version: z.number().int().positive(), payload: configuration }),
  email: z.string().max(1024).optional(),
  displayName: z.string().max(1024).optional(),
  encryptedCredentials: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const accountSnapshotSchema = z.strictObject({
  version: z.literal(1),
  accounts: z.array(accountRecordSchema),
});

export const accountSetupSchema = z.strictObject({
  method: identifier,
  data: configuration.optional(),
});

export type AccountRecord = z.infer<typeof accountRecordSchema>;
export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;
export type CredentialBinding = Pick<
  AccountRecord,
  'id' | 'provider' | 'identityKey' | 'credentialRef' | 'configuration'
>;

export function parseAccountData<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: AccountErrorCode,
): T {
  try {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
  } catch {
    // Invalid/cyclic input must not leak schema contents through raw validation errors.
  }
  throw new AccountError(code);
}

export function connectionDefinition(record: CredentialBinding): ConnectionDefinition {
  return {
    id: record.id,
    provider: record.provider,
    configuration: structuredClone(record.configuration),
    credentialRef: record.credentialRef,
  };
}
