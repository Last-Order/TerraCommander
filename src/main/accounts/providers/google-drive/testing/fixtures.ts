import type { OperationContext } from '../../../../storage/core/contracts';
import { createGoogleDriveProvider } from '../create-provider';
import { googleDriveDescriptor } from '../descriptor';
import { isGoogleDriveAuthorization } from '../credential-resolver';
import { FakeAccountCipher, MemoryAccountStore, TEST_TIME } from '../../../testing/fixtures';
export { TEST_TIME } from '../../../testing/fixtures';
import { vi } from 'vitest';
import type { StorageLogger } from '../../../../storage/ports/services';
import { createAccountServices } from '../../../runtime/account-services';
import { GOOGLE_DRIVE_SCOPES } from '../models';
import type {
  AuthorizationEnvironment,
  GoogleAccountGateway,
  GoogleAuthorizationGrant,
  GoogleAuthorizationRequest,
} from '../ports';

export const TEST_CLIENT_ID = 'test-desktop.apps.googleusercontent.com';
export function authorizationGrant(subject = 'google-subject-personal'): GoogleAuthorizationGrant {
  return {
    subject,
    email: `${subject}@example.test`,
    accessToken: `access-${subject}`,
    refreshToken: `refresh-${subject}`,
    expiresAt: TEST_TIME + 3_600_000,
    grantedScopes: [...GOOGLE_DRIVE_SCOPES],
  };
}

export function accountFixture(options: { authorizationTimeoutMs?: number } = {}) {
  const store = new MemoryAccountStore();
  const cipher = new FakeAccountCipher();
  const clock = { now: TEST_TIME };
  const gateway = {
    clientId: TEST_CLIENT_ID,
    authorizationUrl: vi.fn(
      (_request: GoogleAuthorizationRequest) => 'https://accounts.google.com/o/oauth2/v2/auth',
    ),
    exchange: vi.fn<GoogleAccountGateway['exchange']>().mockResolvedValue(authorizationGrant()),
    refresh: vi.fn<GoogleAccountGateway['refresh']>().mockResolvedValue({
      accessToken: 'refreshed-access',
      expiresAt: TEST_TIME + 7_200_000,
    }),
    check: vi
      .fn<GoogleAccountGateway['check']>()
      .mockResolvedValue({ displayName: 'Personal Drive' }),
  } satisfies GoogleAccountGateway;
  const close = vi.fn(async () => undefined);
  const environment: AuthorizationEnvironment = {
    openBrowser: vi.fn(async () => undefined),
    listen: vi.fn(async () => ({
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
      code: Promise.resolve('authorization-code'),
      close,
    })),
  };
  const logger = { event: vi.fn<StorageLogger['event']>() };
  const createServices = () => {
    const runtime = createAccountServices({
      store,
      cipher,
      now: () => clock.now,
      logger,
      providers: [
        {
          descriptor: googleDriveDescriptor,
          create: (services) =>
            createGoogleDriveProvider(services, {
              gateway,
              authorizationEnvironment: environment,
              ...options,
            }),
        },
      ],
    });
    return {
      ...runtime,
      runtime,
      credentials: {
        resolve: async (reference: string, context: OperationContext) => {
          const handle = await runtime.credentials.resolve(reference, context);
          if (!isGoogleDriveAuthorization(handle))
            throw new Error('Expected a Google authorization handle.');
          return handle;
        },
      },
    };
  };
  return {
    store,
    cipher,
    clock,
    gateway,
    environment,
    close,
    logger,
    createServices,
    ...createServices(),
  };
}
