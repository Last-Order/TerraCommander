import { z } from 'zod';
import { parseAccountData } from '../../../core/models';
import type { GoogleClientConfiguration } from '../ports';

const clientSchema = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
  clientSecret: z.string().min(1).optional(),
});

/** Release configuration is embedded in main only; packaged apps ignore developer overrides. */
export function readGoogleClientConfiguration(
  bundled: GoogleClientConfiguration | undefined,
  development: boolean,
  environment: NodeJS.ProcessEnv,
): GoogleClientConfiguration | undefined {
  const overrideId = development ? environment.GOOGLE_DRIVE_CLIENT_ID : undefined;
  const candidate = overrideId
    ? {
        clientId: overrideId,
        ...(environment.GOOGLE_DRIVE_CLIENT_SECRET
          ? { clientSecret: environment.GOOGLE_DRIVE_CLIENT_SECRET }
          : {}),
      }
    : bundled;
  if (!candidate) return undefined;
  return parseAccountData(clientSchema, candidate, 'ClientConfigurationInvalid');
}
