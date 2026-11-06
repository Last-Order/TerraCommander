import { z } from 'zod';
import { parseAccountData } from '../../../core/models';
import type { GoogleClientConfiguration } from '../ports';

const clientSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
  clientSecret: z.string().min(1).optional(),
});

/** Validate client values selected by the current Vite mode when the provider is first used. */
export function readGoogleClientConfiguration(
  clientId: string | undefined,
  clientSecret?: string,
): GoogleClientConfiguration | undefined {
  if (!clientId) return undefined;
  const candidate = { clientId, ...(clientSecret ? { clientSecret } : {}) };
  return parseAccountData(clientSchema, candidate, 'ClientConfigurationInvalid');
}
