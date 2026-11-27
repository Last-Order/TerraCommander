import type { AppLanguage } from '@shared/language';
import { LazyService } from './lazy-service';
import type { DownloadPreferences } from './preferences/download-preferences';
import type { StorageServices } from './storage/storage-services';
import type { StorageTaskService } from './tasks/storage-task-service';
import type { TransferPreferences } from './tasks/transfer-preferences';

type AccountModule = typeof import('../accounts/runtime/desktop-accounts');
export type AccountRuntime = ReturnType<AccountModule['createDesktopAccountServices']>;

interface ApplicationServicesOptions {
  whenReady: () => Promise<void>;
  getLanguage?: () => AppLanguage;
  loadAccounts?: () => Promise<AccountModule>;
}

/** Lightweight host: constructing it neither loads integrations nor opens their stores. */
export class ApplicationServices {
  readonly accounts: LazyService<AccountRuntime>;
  readonly storage: LazyService<StorageServices>;
  readonly downloadPreferences: LazyService<DownloadPreferences>;
  readonly transferPreferences: LazyService<TransferPreferences>;
  readonly tasks: LazyService<StorageTaskService>;
  private readonly taskPreferenceSubscriptions = new WeakMap<StorageTaskService, () => void>();
  private disposal: Promise<void> | undefined;

  constructor(options: ApplicationServicesOptions) {
    this.downloadPreferences = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const { createDesktopDownloadPreferences } =
          await import('./preferences/desktop-download-preferences');
        signal.throwIfAborted();
        return createDesktopDownloadPreferences();
      },
      dispose: async () => {},
    });
    this.transferPreferences = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const { createDesktopTransferPreferences } =
          await import('./tasks/desktop-transfer-preferences');
        signal.throwIfAborted();
        return createDesktopTransferPreferences();
      },
      dispose: async () => {},
    });
    this.accounts = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const module = await (options.loadAccounts
          ? options.loadAccounts()
          : import('../accounts/runtime/desktop-accounts'));
        signal.throwIfAborted();
        return module.createDesktopAccountServices(options.getLanguage);
      },
      dispose: (runtime) => runtime.dispose(),
    });
    this.storage = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const { createDesktopStorageServices } = await import('./storage/desktop-storage-services');
        signal.throwIfAborted();
        return createDesktopStorageServices((operation) => this.accounts.get(operation));
      },
      dispose: (storage) => storage.dispose(),
    });
    this.tasks = new LazyService({
      create: async (signal) => {
        const [storage, transferPreferences] = await Promise.all([
          this.storage.get(signal),
          this.transferPreferences.get(signal),
        ]);
        signal.throwIfAborted();
        const { StorageTaskService } = await import('./tasks/storage-task-service');
        signal.throwIfAborted();
        const service = new StorageTaskService(
          {
            operations: storage.operations,
            downloads: storage.downloads,
            uploads: storage.uploads,
          },
          {
            transferConcurrency: transferPreferences.get().concurrencyLimit,
          },
        );
        const unsubscribe = transferPreferences.subscribe((settings) => {
          service.setTransferConcurrency(settings.concurrencyLimit);
        });
        this.taskPreferenceSubscriptions.set(service, unsubscribe);
        return service;
      },
      dispose: (tasks) => {
        this.taskPreferenceSubscriptions.get(tasks)?.();
        this.taskPreferenceSubscriptions.delete(tasks);
        return tasks.dispose();
      },
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
      shutdowns.push(
        this.tasks.dispose(),
        this.storage.dispose(),
        this.accounts.dispose(),
        this.downloadPreferences.dispose(),
        this.transferPreferences.dispose(),
      );
    }
    return this.disposal;
  }
}
