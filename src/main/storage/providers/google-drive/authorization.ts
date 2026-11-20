import type { ConnectionDefinition } from '@shared/storage';
import type { OperationContext } from '@main/storage/core/contracts';

export interface GoogleDriveAuthorization {
  readonly provider: 'google-drive';
  readonly connectionId: string;
  readonly subject: string;
  readonly oauthClientId: string;
  getAccessToken(ctx?: OperationContext): Promise<string>;
}

export function isGoogleDriveAuthorization(value: unknown): value is GoogleDriveAuthorization {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provider' in value &&
    value.provider === 'google-drive' &&
    'connectionId' in value &&
    typeof value.connectionId === 'string' &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    'oauthClientId' in value &&
    typeof value.oauthClientId === 'string' &&
    'getAccessToken' in value &&
    typeof value.getAccessToken === 'function'
  );
}

/** Adapter factories can verify handles without importing account modules or Google SDK types. */
export function matchesGoogleDriveAuthorization(
  authorization: unknown,
  connection: ConnectionDefinition,
): authorization is GoogleDriveAuthorization {
  return (
    isGoogleDriveAuthorization(authorization) &&
    authorization.provider === connection.provider &&
    authorization.connectionId === connection.id &&
    authorization.subject === connection.configuration.subject &&
    authorization.oauthClientId === connection.configuration.oauthClientId
  );
}
