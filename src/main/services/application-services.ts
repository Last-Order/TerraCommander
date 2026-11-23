import type { AppLanguage } from '@shared/language';
import type { DownloadPreferences } from './downloads/download-preferences';
import { LazyService } from './lazy-service';
import type { StorageBrowser } from './storage/storage-browser';
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
  readonly storageBrowser: LazyService<StorageBrowser>;
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
          await import('./downloads/desktop-download-preferences');
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
    this.storageBrowser = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const { createDesktopStorageBrowser } = await import('./storage/desktop-storage-browser');
        signal.throwIfAborted();
        return createDesktopStorageBrowser((operation) => this.accounts.get(operation));
      },
      dispose: (browser) => browser.dispose(),
    });
    this.tasks = new LazyService({
      create: async (signal) => {
        const [browser, transferPreferences] = await Promise.all([
          this.storageBrowser.get(signal),
          this.transferPreferences.get(signal),
        ]);
        signal.throwIfAborted();
        const { StorageTaskService } = await import('./tasks/storage-task-service');
        signal.throwIfAborted();
        const service = new StorageTaskService(browser, {
          transferConcurrency: transferPreferences.get().concurrencyLimit,
        });
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
        this.storageBrowser.dispose(),
        this.accounts.dispose(),
        this.downloadPreferences.dispose(),
        this.transferPreferences.dispose(),
      );
    }
    return this.disposal;
  }
}
