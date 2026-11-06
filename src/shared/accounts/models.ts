import type { JsonObject } from '../storage';
import type { AccountErrorCode } from './errors';

export interface AccountCheck {
  checkedAt: string;
  outcome: 'ok' | 'failed';
  email?: string | undefined;
  displayName?: string | undefined;
  errorCode?: AccountErrorCode | undefined;
}

export interface AccountState {
  authorization: 'unchecked' | 'authorized' | 'reauthorization-required';
  credentials: 'unchecked' | 'available' | 'unavailable' | 'not-required';
  lastCheck?: AccountCheck | undefined;
}

/** Public metadata contains neither credential references nor provider-private payloads. */
export interface AccountSummary extends AccountState {
  id: string;
  provider: string;
  email?: string | undefined;
  displayName?: string | undefined;
}

export interface AuthenticationMethod {
  id: string;
  kind: 'browser' | 'credentials' | 'none';
  name: string;
}

export interface AccountProviderDescriptor {
  id: string;
  name: string;
  capabilities: {
    authenticationMethods: AuthenticationMethod[];
    updateAuthentication: boolean;
    verify: boolean;
  };
}

/** Backend input. Each provider validates the fields for its selected authentication method. */
export interface AccountSetupRequest {
  method: string;
  data?: JsonObject | undefined;
}
