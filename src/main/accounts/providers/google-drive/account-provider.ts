import type { AccountCheck, AccountState, AccountSetupRequest } from '../../../../shared/accounts';
import type { OperationContext } from '../../../storage/core/contracts';
import type { StorageLogger } from '../../../storage/ports/services';
import type { AccountGrantWriter } from './grant-writer';
import type { GoogleAccountRepository } from './account-repository';
import type { GoogleAuthorizationFlow } from './oauth/authorization-flow';
import { accountError, assertNotCancelled, AccountError } from '../../core/errors';
import { requireDriveScope, type GoogleAccountRecord } from './models';
import { parseAccountData } from '../../core/models';
import { accountOperationScope, waitForAccountOperation } from '../../core/operations';
import type { GoogleAccountGateway } from './ports';
import type { GoogleTokenProvider } from './token-provider';
import { GoogleDriveCredentialResolver } from './credential-resolver';
import type { AccountProvider } from '../../core/ports';
import { z } from 'zod';

const browserSetupSchema = z.strictObject({
  method: z.literal('browser'),
  data: z.strictObject({}).optional(),
});

interface GoogleAccountProviderOptions {
  repository: GoogleAccountRepository;
  grantWriter: AccountGrantWriter;
  authorization: GoogleAuthorizationFlow;
  gateway: GoogleAccountGateway;
  tokens: GoogleTokenProvider;
  now: () => number;
  authorizationTimeoutMs?: number;
  logger?: StorageLogger;
}

interface AuthorizationAttempt {
  controller: AbortController;
  accountId?: string;
}

/** Owns user-facing account lifecycles; neither storage adapters nor token refreshes open login UI. */
export class GoogleDriveAccountProvider implements AccountProvider {
  readonly id = 'google-drive';
  private readonly lifetime = new AbortController();
  private readonly accountLifetimes = new Map<string, AbortController>();
  private readonly checks = new Map<string, AccountCheck>();
  private activeAttempt: AuthorizationAttempt | undefined;

  private readonly resolver: GoogleDriveCredentialResolver;

  constructor(private readonly options: GoogleAccountProviderOptions) {
    this.resolver = new GoogleDriveCredentialResolver(options.repository, options.tokens);
  }

  async add(request: AccountSetupRequest, ctx: OperationContext = {}): Promise<string> {
    parseAccountData(browserSetupSchema, request, 'InvalidArgument');
    return this.authorize(undefined, ctx);
  }

  async updateAuthentication(
    id: string,
    request: AccountSetupRequest,
    ctx: OperationContext = {},
  ): Promise<void> {
    parseAccountData(browserSetupSchema, request, 'InvalidArgument');
    this.assertOpen();
    await this.authorize(this.options.repository.get(id), ctx);
  }

  getState(id: string): AccountState {
    this.assertOpen();
    return { ...this.options.tokens.status(id), lastCheck: structuredClone(this.checks.get(id)) };
  }

  resolveCredentials(reference: string, ctx: OperationContext): Promise<unknown> {
    return this.resolver.resolve(reference, ctx);
  }

  async verify(id: string, ctx: OperationContext = {}): Promise<AccountCheck> {
    this.assertOpen();
    this.options.repository.get(id);
    const scope = accountOperationScope(ctx, this.accountSignal(id));
    try {
      // A stale access token may fail while its refresh grant is still valid. Only
      // the read-only probe is retried once, after obtaining a fresh access token.
      for (let attempt = 0; attempt < 2; attempt++) {
        const accessToken = await this.options.tokens.getAccessToken(id, scope.context);
        try {
          const profile = await waitForAccountOperation(
            this.options.gateway.check(accessToken, scope.context),
            scope.context.signal,
          );
          assertNotCancelled(scope.context.signal);
          const check: AccountCheck = {
            checkedAt: this.timestamp(),
            outcome: 'ok',
            email: profile.email,
            displayName: profile.displayName,
          };
          this.checks.set(id, check);
          return structuredClone(check);
        } catch (error) {
          const failure = accountError(error, scope.context.signal);
          if (failure.code === 'AuthRequired' && attempt === 0) {
            this.options.tokens.invalidate(id);
            continue;
          }
          throw failure;
        }
      }
      throw new AccountError('InvalidResponse');
    } catch (error) {
      const failure = accountError(error, scope.context.signal);
      if (failure.code === 'AuthRequired') this.options.tokens.requireReauthorization(id);
      this.checks.set(id, {
        checkedAt: this.timestamp(),
        outcome: 'failed',
        errorCode: failure.code,
      });
      this.log('verify', 'failed', failure.code);
      throw failure;
    } finally {
      scope.dispose();
    }
  }

  async remove(id: string, ctx: OperationContext = {}): Promise<void> {
    this.assertOpen();
    assertNotCancelled(ctx.signal);
    const record = this.options.repository.get(id);
    // An add attempt does not know its Google identity yet. Cancel it conservatively
    // so a late duplicate login cannot recreate the account being removed.
    if (
      this.activeAttempt &&
      (!this.activeAttempt.accountId || this.activeAttempt.accountId === id)
    ) {
      this.activeAttempt.controller.abort();
    }
    this.invalidateAccountWork(id);
    const releaseBlock = this.options.tokens.block(id);
    const scope = accountOperationScope(ctx, this.lifetime.signal);
    try {
      await this.options.repository.remove(id, record.revision, scope.context);
      this.options.tokens.invalidate(id);
      this.checks.delete(id);
      this.log('remove', 'succeeded');
    } finally {
      // A failed disk write leaves the old account usable, but never revives old work.
      releaseBlock();
      scope.dispose();
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    this.activeAttempt?.controller.abort();
    for (const lifetime of this.accountLifetimes.values()) lifetime.abort();
    this.options.tokens.dispose();
    await this.options.repository.flush();
  }

  private async authorize(selected: GoogleAccountRecord | undefined, ctx: OperationContext) {
    this.assertOpen();
    assertNotCancelled(ctx.signal);
    if (this.activeAttempt) throw new AccountError('Busy');
    const clientId = this.options.gateway.clientId;
    if (!clientId || (selected && selected.oauthClientId !== clientId)) {
      throw new AccountError('ClientConfigurationInvalid');
    }

    const attempt: AuthorizationAttempt = { controller: new AbortController() };
    if (selected) attempt.accountId = selected.id;
    this.activeAttempt = attempt;
    const scope = accountOperationScope(
      ctx,
      AbortSignal.any([this.lifetime.signal, attempt.controller.signal]),
      this.options.authorizationTimeoutMs ?? 5 * 60_000,
    );
    let releaseBlock: (() => void) | undefined;
    let reuseRefreshToken =
      !selected ||
      this.options.tokens.status(selected.id).authorization !== 'reauthorization-required';
    if (selected) {
      this.invalidateAccountWork(selected.id);
      releaseBlock = this.options.tokens.block(selected.id);
    }

    try {
      const grant = await this.options.authorization.authorize(scope.context, selected?.subject);
      assertNotCancelled(scope.context.signal);
      requireDriveScope(grant.grantedScopes);
      if (selected && grant.subject !== selected.subject) {
        throw new AccountError('IdentityMismatch');
      }
      const existing = selected ?? this.options.repository.findIdentity(grant.subject, clientId);
      if (existing && !selected) {
        reuseRefreshToken =
          this.options.tokens.status(existing.id).authorization !== 'reauthorization-required';
        attempt.accountId = existing.id;
        this.invalidateAccountWork(existing.id);
        releaseBlock = this.options.tokens.block(existing.id);
      }
      const record = await this.options.grantWriter.save(
        { grant, existing, reuseRefreshToken },
        scope.context,
      );
      releaseBlock?.();
      this.options.tokens.accept(record, grant);
      this.checks.set(record.id, { checkedAt: this.timestamp(), outcome: 'ok' });
      this.log(selected ? 'reauthorize' : 'add', 'succeeded');
      return record.id;
    } catch (error) {
      const failure = accountError(error, scope.context.signal);
      this.log(selected ? 'reauthorize' : 'add', 'failed', failure.code);
      throw failure;
    } finally {
      releaseBlock?.();
      scope.dispose();
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
    }
  }

  private accountSignal(id: string): AbortSignal {
    let lifetime = this.accountLifetimes.get(id);
    if (!lifetime) {
      lifetime = new AbortController();
      this.accountLifetimes.set(id, lifetime);
    }
    return AbortSignal.any([lifetime.signal, this.lifetime.signal]);
  }

  private invalidateAccountWork(id: string): void {
    this.accountLifetimes.get(id)?.abort();
    this.accountLifetimes.delete(id);
  }

  private timestamp(): string {
    return new Date(this.options.now()).toISOString();
  }

  private assertOpen(): void {
    assertNotCancelled(this.lifetime.signal);
  }

  private log(operation: string, result: string, errorCode?: string): void {
    try {
      this.options.logger?.event('google-drive.account', {
        operation,
        result,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // A diagnostic sink cannot turn an already committed account change into failure.
    }
  }
}
