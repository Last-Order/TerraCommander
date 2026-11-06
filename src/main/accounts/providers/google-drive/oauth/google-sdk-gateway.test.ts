import { gaxios, LoginTicket, OAuth2Client, type VerifyIdTokenOptions } from 'google-auth-library';
import { describe, expect, it, vi } from 'vitest';
import { googleRequestError } from './google-errors';
import { GoogleSdkGateway } from './google-sdk-gateway';
import { DRIVE_SCOPE } from '../models';
import { TEST_CLIENT_ID } from '../testing/fixtures';

/** Exercise the real SDK's request construction without contacting Google's endpoints. */
function gatewayFixture(responses: unknown[]) {
  const requests: gaxios.GaxiosOptionsPrepared[] = [];
  const gateway = new GoogleSdkGateway(
    { clientId: TEST_CLIENT_ID },
    () =>
      new gaxios.Gaxios({
        adapter: async <T>(options: gaxios.GaxiosOptionsPrepared) => {
          requests.push(options);
          return Object.assign(new Response(null, { status: 200 }), {
            config: options,
            data: responses.shift() as T,
          });
        },
      }),
  );
  return { gateway, requests };
}

function verifiedTicket(nonce = 'expected-nonce') {
  return new LoginTicket('', {
    iss: 'https://accounts.google.com',
    aud: TEST_CLIENT_ID,
    sub: 'subject',
    nonce,
    iat: 1,
    exp: 9_999_999_999,
  });
}

function stubIdentityVerification(ticket: LoginTicket) {
  // Narrow the SDK's callback overload to the Promise API exercised by the gateway.
  const verifier: { verifyIdToken(options: VerifyIdTokenOptions): Promise<LoginTicket> } =
    OAuth2Client.prototype;
  return vi.spyOn(verifier, 'verifyIdToken').mockResolvedValue(ticket);
}

describe('Google SDK integration boundary', () => {
  it('uses offline Desktop OAuth with PKCE, account selection, and exact code exchange', async () => {
    const fixture = gatewayFixture([
      {
        access_token: 'private-access',
        refresh_token: 'private-refresh',
        id_token: 'private-id-token',
        expires_in: 3600,
        scope: `openid email ${DRIVE_SCOPE}`,
        token_type: 'Bearer',
      },
    ]);
    const request = {
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
      state: 'random-state',
      nonce: 'expected-nonce',
      codeChallenge: 'challenge',
    };
    const url = new URL(fixture.gateway.authorizationUrl(request));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toContain('select_account');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('expected-nonce');
    const verify = stubIdentityVerification(verifiedTicket());
    const controller = new AbortController();
    const grant = await fixture.gateway.exchange(
      { ...request, code: 'private-code', codeVerifier: 'private-verifier' },
      { signal: controller.signal },
    );
    expect(grant.subject).toBe('subject');
    expect(grant.refreshToken).toBe('private-refresh');
    expect(verify).toHaveBeenCalledWith({ idToken: 'private-id-token', audience: TEST_CLIENT_ID });
    const outgoing = fixture.requests[0]!;
    expect(outgoing.retry).toBe(false);
    expect(outgoing.signal).toBe(controller.signal);
    expect(outgoing.timeout).toBe(30_000);
    if (typeof outgoing.body !== 'string' && !(outgoing.body instanceof URLSearchParams)) {
      throw new Error('Expected a form-encoded OAuth request.');
    }
    const form = new URLSearchParams(outgoing.body);
    expect(form.get('code_verifier')).toBe('private-verifier');
    expect(form.get('redirect_uri')).toBe(request.redirectUri);
    expect(form.has('client_secret')).toBe(false);
  });

  it('rejects an incorrect nonce or failed ID-token verification', async () => {
    const verify = stubIdentityVerification(verifiedTicket('another-nonce'));
    const raw = {
      access_token: 'access',
      id_token: 'id-token',
      expires_in: 3600,
      scope: DRIVE_SCOPE,
    };
    const fixture = gatewayFixture([raw, { ...raw }]);
    const request = {
      code: 'code',
      codeVerifier: 'verifier',
      nonce: 'expected-nonce',
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
    };
    await expect(fixture.gateway.exchange(request, {})).rejects.toMatchObject({
      code: 'IdentityMismatch',
    });
    verify.mockRejectedValue(new Error('private JWT verification detail'));
    await expect(fixture.gateway.exchange(request, {})).rejects.toMatchObject({
      code: 'IdentityMismatch',
    });
  });

  it('captures a rotated refresh token before the SDK overwrites it and limits the Drive probe fields', async () => {
    const fixture = gatewayFixture([
      {
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      },
      {
        user: { displayName: 'Work account', emailAddress: 'work@example.test' },
        ignoredField: true,
      },
    ]);
    const tokens = await fixture.gateway.refresh('old-refresh', 'subject', {});
    expect(tokens.refreshToken).toBe('rotated-refresh');
    expect(tokens.refreshExpiresAt).toBeGreaterThan(Date.now());
    expect(await fixture.gateway.check(tokens.accessToken, {})).toEqual({
      displayName: 'Work account',
      email: 'work@example.test',
    });
    const probe = fixture.requests[1]!;
    expect(new URL(String(probe.url)).searchParams.get('fields')).toBe(
      'user(displayName,emailAddress)',
    );
    expect(probe.headers.get('Authorization')).toBe('Bearer new-access');
    expect(probe.retry).toBe(false);
  });

  it('maps provider failures to safe and distinct error categories', () => {
    const cases = [
      [{ response: { status: 400, data: { error: 'invalid_grant' } } }, 'AuthRequired'],
      [
        { response: { status: 400, data: { error: 'invalid_client' } } },
        'ClientConfigurationInvalid',
      ],
      [
        {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: 'accessNotConfigured' }] } },
          },
        },
        'ApiDisabled',
      ],
      [
        {
          response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
        },
        'RateLimited',
      ],
      [
        {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
          },
        },
        'InsufficientScope',
      ],
      [{ response: { status: 403 } }, 'AccessBlocked'],
      [{ response: { status: 503 } }, 'NetworkError'],
      [{ response: { status: 429, data: 'temporarily unavailable' } }, 'RateLimited'],
      [{ code: 'ETIMEDOUT' }, 'Timeout'],
    ] as const;
    for (const [failure, expected] of cases) {
      const safe = googleRequestError({ ...failure, privateToken: 'do-not-log' });
      expect(safe.code).toBe(expected);
      expect(JSON.stringify(safe)).not.toContain('do-not-log');
    }
  });
});
