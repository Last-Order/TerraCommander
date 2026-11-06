import {
  ClientAuthentication,
  CodeChallengeMethod,
  gaxios,
  OAuth2Client,
} from 'google-auth-library';
import { z } from 'zod';
import type { OperationContext } from '../../../../storage/core/contracts';
import { assertNotCancelled, AccountError } from '../../../core/errors';
import { googleRequestError } from './google-errors';
import { GOOGLE_DRIVE_SCOPES } from '../models';
import { parseAccountData } from '../../../core/models';
import type {
  GoogleAccountGateway,
  GoogleAccountProfile,
  GoogleAuthorizationGrant,
  GoogleAuthorizationRequest,
  GoogleClientConfiguration,
  GoogleCodeExchange,
  GoogleTokenSet,
} from '../ports';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expiry_date: z.number().finite().positive(),
  refresh_token: z.string().min(1).nullish(),
  refresh_token_expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  token_type: z.string().optional(),
});
const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  nonce: z.string().optional(),
  azp: z.string().optional(),
  email: z.string().optional(),
});
const profileSchema = z.object({
  user: z.object({ emailAddress: z.string().optional(), displayName: z.string().optional() }),
});

type TransportFactory = () => gaxios.Gaxios;

/** SDK calls and the Drive probe share the same transport policy, never SDK request replay. */
export class GoogleSdkGateway implements GoogleAccountGateway {
  readonly clientId: string | undefined;

  constructor(
    private readonly configuration: GoogleClientConfiguration | undefined,
    private readonly transportFactory: TransportFactory = () => new gaxios.Gaxios(),
  ) {
    this.clientId = configuration?.clientId;
  }

  authorizationUrl(request: GoogleAuthorizationRequest): string {
    const client = this.client({});
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      scope: [...GOOGLE_DRIVE_SCOPES],
      redirect_uri: request.redirectUri,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      ...(request.loginHint ? { login_hint: request.loginHint } : {}),
    });
  }

  async exchange(
    request: GoogleCodeExchange,
    ctx: OperationContext,
  ): Promise<GoogleAuthorizationGrant> {
    const client = this.client(ctx);
    try {
      const response = await client.getToken({
        code: request.code,
        codeVerifier: request.codeVerifier,
        redirect_uri: request.redirectUri,
      });
      const raw = parseAccountData(tokenResponseSchema, response.tokens, 'InvalidResponse');
      if (!raw.id_token) throw new AccountError('InvalidResponse');
      const identity = await this.verifyIdentity(client, raw.id_token, ctx);
      if (identity.nonce !== request.nonce) throw new AccountError('IdentityMismatch');
      const tokens = this.tokens(raw);
      // Missing scope metadata must not be replaced by the scopes we asked for.
      if (!tokens.grantedScopes) throw new AccountError('InsufficientScope');
      assertNotCancelled(ctx.signal);
      return {
        ...tokens,
        subject: identity.sub,
        email: identity.email,
        grantedScopes: tokens.grantedScopes,
      };
    } catch (error) {
      throw googleRequestError(error, ctx.signal);
    }
  }

  async refresh(
    refreshToken: string,
    subject: string,
    ctx: OperationContext,
  ): Promise<GoogleTokenSet> {
    const client = this.client(ctx);
    client.setCredentials({ refresh_token: refreshToken });
    let receivedTokens: unknown;
    // The SDK overwrites refresh_token after emitting this event. Copy the response
    // now so a rotated token is not silently lost; persistence is awaited by our caller.
    client.on('tokens', (tokens) => {
      receivedTokens = structuredClone(tokens);
    });
    try {
      await client.refreshAccessToken();
      const raw = parseAccountData(tokenResponseSchema, receivedTokens, 'InvalidResponse');
      if (raw.id_token) {
        const identity = await this.verifyIdentity(client, raw.id_token, ctx);
        if (identity.sub !== subject) throw new AccountError('IdentityMismatch');
      }
      assertNotCancelled(ctx.signal);
      return this.tokens(raw);
    } catch (error) {
      throw googleRequestError(error, ctx.signal);
    }
  }

  async check(accessToken: string, ctx: OperationContext): Promise<GoogleAccountProfile> {
    try {
      const client = this.client(ctx);
      const response = await client.transporter.request<unknown>({
        url: 'https://www.googleapis.com/drive/v3/about',
        params: { fields: 'user(displayName,emailAddress)' },
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const profile = parseAccountData(profileSchema, response.data, 'InvalidResponse').user;
      assertNotCancelled(ctx.signal);
      return { email: profile.emailAddress, displayName: profile.displayName };
    } catch (error) {
      throw googleRequestError(error, ctx.signal);
    }
  }

  private client(ctx: OperationContext): OAuth2Client {
    assertNotCancelled(ctx.signal);
    if (!this.configuration) throw new AccountError('ClientConfigurationInvalid');
    const client = new OAuth2Client({
      clientId: this.configuration.clientId,
      ...(this.configuration.clientSecret ? { clientSecret: this.configuration.clientSecret } : {}),
      clientAuthentication: this.configuration.clientSecret
        ? ClientAuthentication.ClientSecretPost
        : ClientAuthentication.None,
      transporter: this.transportFactory(),
    });
    client.transporter.interceptors.request.add({
      resolved: async (options) => {
        // SDK methods explicitly enable retries, so defaults alone cannot disable code replay.
        options.retry = false;
        options.timeout = 30_000;
        options.maxRedirects = 0;
        options.redirect = 'error';
        if (ctx.signal) options.signal = ctx.signal;
        return options;
      },
    });
    return client;
  }

  private async verifyIdentity(client: OAuth2Client, idToken: string, ctx: OperationContext) {
    let ticket;
    try {
      const audience = this.clientId;
      if (!audience) throw new AccountError('ClientConfigurationInvalid');
      ticket = await client.verifyIdToken({ idToken, audience });
    } catch (error) {
      assertNotCancelled(ctx.signal);
      if (error instanceof gaxios.GaxiosError || error instanceof AccountError) throw error;
      throw new AccountError('IdentityMismatch', error);
    }
    const identity = parseAccountData(identitySchema, ticket.getPayload(), 'IdentityMismatch');
    if (identity.azp && identity.azp !== this.clientId) {
      throw new AccountError('IdentityMismatch');
    }
    assertNotCancelled(ctx.signal);
    return identity;
  }

  private tokens(raw: z.infer<typeof tokenResponseSchema>): GoogleTokenSet {
    if (raw.token_type && raw.token_type.toLowerCase() !== 'bearer') {
      throw new AccountError('InvalidResponse');
    }
    return {
      accessToken: raw.access_token,
      expiresAt: raw.expiry_date,
      refreshToken: raw.refresh_token ?? undefined,
      refreshExpiresAt:
        raw.refresh_token_expires_in === undefined
          ? undefined
          : Date.now() + raw.refresh_token_expires_in * 1000,
      grantedScopes: raw.scope?.split(/\s+/).filter(Boolean),
    };
  }
}
