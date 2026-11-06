import type { OperationContext } from '../../../storage/core/contracts';

export interface GoogleClientConfiguration {
  clientId: string;
  clientSecret?: string | undefined;
}

export interface GoogleTokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string | undefined;
  refreshExpiresAt?: number | undefined;
  grantedScopes?: string[] | undefined;
}

export interface GoogleAccountProfile {
  email?: string | undefined;
  displayName?: string | undefined;
}

export interface GoogleAuthorizationGrant extends GoogleTokenSet {
  subject: string;
  email?: string | undefined;
  grantedScopes: string[];
}

export interface GoogleAuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  loginHint?: string | undefined;
}

export interface GoogleCodeExchange {
  redirectUri: string;
  code: string;
  codeVerifier: string;
  nonce: string;
}

export interface GoogleAccountGateway {
  readonly clientId: string | undefined;
  authorizationUrl(request: GoogleAuthorizationRequest): string;
  exchange(request: GoogleCodeExchange, ctx: OperationContext): Promise<GoogleAuthorizationGrant>;
  refresh(refreshToken: string, subject: string, ctx: OperationContext): Promise<GoogleTokenSet>;
  check(accessToken: string, ctx: OperationContext): Promise<GoogleAccountProfile>;
}

export interface AuthorizationCallback {
  readonly redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}

export interface AuthorizationEnvironment {
  openBrowser: (url: string) => Promise<void>;
  listen: (state: string, signal: AbortSignal) => Promise<AuthorizationCallback>;
}
