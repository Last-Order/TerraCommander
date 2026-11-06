import { LazyService } from './lazy-service';

type AccountModule = typeof import('../accounts/runtime/desktop-accounts');
export type AccountRuntime = ReturnType<AccountModule['createDesktopAccountServices']>;

interface ApplicationServicesOptions {
  whenReady: () => Promise<void>;
  loadAccounts?: () => Promise<AccountModule>;
}

/** Lightweight host: constructing it neither loads integrations nor opens their stores. */
export class ApplicationServices {
  readonly accounts: LazyService<AccountRuntime>;
  private disposal: Promise<void> | undefined;

  constructor(options: ApplicationServicesOptions) {
    this.accounts = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const module = await (options.loadAccounts
          ? options.loadAccounts()
          : import('../accounts/runtime/desktop-accounts'));
        signal.throwIfAborted();
        return module.createDesktopAccountServices();
      },
      dispose: (runtime) => runtime.dispose(),
    });
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      const shutdowns: Promise<void>[] = [];
      // Reserve owner cleanup before closing slots: their abort listeners may re-enter.
      this.disposal = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(shutdowns);
        const failures = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason as unknown);
        if (failures.length)
          throw new AggregateError(failures, 'Application service cleanup failed.');
      });
      // Close slots immediately and directly; get() would initialize unused services.
      shutdowns.push(this.accounts.dispose());
    }
    return this.disposal;
  }
}
