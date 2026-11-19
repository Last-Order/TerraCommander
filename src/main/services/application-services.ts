import type { AppLanguage } from '../../shared/language';
import { LazyService } from './lazy-service';
import type { StorageBrowser } from './storage-browser';
import type { DownloadPreferences } from './download-preferences';
import type { StorageTaskService } from './storage-task-service';

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
  readonly tasks: LazyService<StorageTaskService>;
  private disposal: Promise<void> | undefined;

  constructor(options: ApplicationServicesOptions) {
    this.downloadPreferences = new LazyService({
      create: async (signal) => {
        await options.whenReady();
        signal.throwIfAborted();
        const { createDesktopDownloadPreferences } = await import('./desktop-download-preferences');
        signal.throwIfAborted();
        return createDesktopDownloadPreferences();
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
        const { createDesktopStorageBrowser } = await import('./desktop-storage-browser');
        signal.throwIfAborted();
        return createDesktopStorageBrowser((operation) => this.accounts.get(operation));
      },
      dispose: (browser) => browser.dispose(),
    });
    this.tasks = new LazyService({
      create: async (signal) => {
        const browser = await this.storageBrowser.get(signal);
        signal.throwIfAborted();
        const { StorageTaskService } = await import('./storage-task-service');
        signal.throwIfAborted();
        return new StorageTaskService(browser);
      },
      dispose: (tasks) => tasks.dispose(),
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
      );
    }
    return this.disposal;
  }
}
