import { z } from 'zod';
import type { AccountProviderDescriptor } from '../../../shared/accounts';
import { LazyService } from '../../services/lazy-service';
import { AccountError, accountError, assertNotCancelled } from './errors';
import { parseAccountData } from './models';
import type {
  AccountProvider,
  AccountProviderRegistration,
  AccountProviderServices,
} from './ports';

const descriptorSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  capabilities: z.strictObject({
    authenticationMethods: z.array(
      z.strictObject({
        id: z.string().min(1),
        name: z.string().min(1),
        kind: z.enum(['browser', 'credentials', 'none']),
      }),
    ),
    verify: z.boolean(),
    updateAuthentication: z.boolean(),
  }),
});

/** Registration contains SDK-free metadata and a factory; only get() initializes a provider. */
export class AccountProviderRegistry {
  private readonly entries = new Map<
    string,
    { descriptor: AccountProviderDescriptor; service: LazyService<AccountProvider> }
  >();
  private readonly loaded = new Map<string, AccountProvider>();
  private closed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly services: AccountProviderServices) {}

  register(registration: AccountProviderRegistration): void {
    this.assertOpen();
    if (typeof registration.create !== 'function') throw new AccountError('InvalidArgument');
    const descriptor = parseAccountData(
      descriptorSchema,
      registration.descriptor,
      'InvalidArgument',
    );
    const methodIds = descriptor.capabilities.authenticationMethods.map((method) => method.id);
    const hasDuplicateMethods = new Set(methodIds).size !== methodIds.length;
    if (this.entries.has(descriptor.id) || hasDuplicateMethods) {
      throw new AccountError('InvalidArgument');
    }
    const service = new LazyService<AccountProvider>({
      create: async (signal) => {
        const provider = await registration.create(this.services, signal);
        if (provider.id !== descriptor.id) {
          await provider.dispose();
          throw new AccountError('InvalidResponse');
        }
        this.loaded.set(descriptor.id, provider);
        return provider;
      },
      dispose: async (provider) => {
        try {
          await provider.dispose();
        } finally {
          this.loaded.delete(descriptor.id);
        }
      },
    });
    this.entries.set(descriptor.id, { descriptor, service });
  }

  list(): AccountProviderDescriptor[] {
    this.assertOpen();
    return [...this.entries.values()].map((entry) => structuredClone(entry.descriptor));
  }

  descriptor(id: string): AccountProviderDescriptor {
    this.assertOpen();
    const entry = this.entries.get(id);
    if (!entry) throw new AccountError('Unsupported');
    return structuredClone(entry.descriptor);
  }

  peek(id: string): AccountProvider | undefined {
    return this.closed ? undefined : this.loaded.get(id);
  }

  async get(id: string, signal?: AbortSignal): Promise<AccountProvider> {
    this.assertOpen();
    assertNotCancelled(signal);
    const entry = this.entries.get(id);
    if (!entry) throw new AccountError('Unsupported');
    try {
      const provider = await entry.service.get(signal);
      this.assertOpen();
      assertNotCancelled(signal);
      return provider;
    } catch (error) {
      this.assertOpen();
      throw accountError(error, signal);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    const shutdowns: Promise<void>[] = [];
    this.disposal = Promise.resolve().then(async () => {
      const failures = (await Promise.allSettled(shutdowns)).filter(
        (result) => result.status === 'rejected',
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason as unknown),
          'Account provider cleanup failed.',
        );
    });
    for (const entry of this.entries.values()) shutdowns.push(entry.service.dispose());
    return this.disposal;
  }

  private assertOpen(): void {
    if (this.closed) throw new AccountError('Cancelled');
  }
}
