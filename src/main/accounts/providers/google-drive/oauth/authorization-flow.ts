import { createHash, randomBytes } from 'node:crypto';
import type { OperationContext } from '../../../../storage/core/contracts';
import { accountError, assertNotCancelled, AccountError } from '../../../core/errors';
import { waitForAccountOperation } from '../../../core/operations';
import type {
  AuthorizationEnvironment,
  GoogleAccountGateway,
  GoogleAuthorizationGrant,
} from '../ports';

export class GoogleAuthorizationFlow {
  constructor(
    private readonly gateway: GoogleAccountGateway,
    private readonly environment: AuthorizationEnvironment,
  ) {}

  async authorize(ctx: OperationContext, loginHint?: string): Promise<GoogleAuthorizationGrant> {
    assertNotCancelled(ctx.signal);
    const signal = ctx.signal ?? new AbortController().signal;
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const callback = await this.environment.listen(state, signal);

    try {
      assertNotCancelled(signal);
      const url = this.gateway.authorizationUrl({
        redirectUri: callback.redirectUri,
        state,
        nonce,
        codeChallenge: challenge,
        loginHint,
      });
      try {
        await waitForAccountOperation(this.environment.openBrowser(url), signal);
      } catch (error) {
        assertNotCancelled(signal);
        throw new AccountError('BrowserUnavailable', error);
      }
      const code = await waitForAccountOperation(callback.code, signal);
      const grant = await waitForAccountOperation(
        this.gateway.exchange(
          {
            redirectUri: callback.redirectUri,
            code,
            codeVerifier: verifier,
            nonce,
          },
          ctx,
        ),
        signal,
      );
      assertNotCancelled(signal);
      return grant;
    } catch (error) {
      throw accountError(error, signal);
    } finally {
      await callback.close();
    }
  }
}
