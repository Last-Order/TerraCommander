import { z } from 'zod';
import { AccountError } from '@main/accounts/core/errors';
import {
  defaultTransferConcurrency,
  maxTransferConcurrency,
  minTransferConcurrency,
  type TransferSettings,
} from '@shared/tasks';

export const transferConcurrencySchema = z
  .number()
  .int()
  .min(minTransferConcurrency)
  .max(maxTransferConcurrency);

export interface TransferPreferencesStore {
  read(): unknown;
  write(concurrencyLimit: number): void;
}

/** Persists transfer task settings and notifies active listeners on change. */
export class TransferPreferences {
  private concurrencyLimit: number = defaultTransferConcurrency;
  private readonly listeners = new Set<(settings: TransferSettings) => void>();

  constructor(
    private readonly store: TransferPreferencesStore,
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    try {
      const saved = transferConcurrencySchema.safeParse(this.store.read());
      if (saved.success) this.concurrencyLimit = saved.data;
    } catch {
      this.onWarn('Could not read the transfer concurrency preference');
    }
  }

  get(): TransferSettings {
    return { concurrencyLimit: this.concurrencyLimit };
  }

  setConcurrencyLimit(limit: number): TransferSettings {
    const parsed = transferConcurrencySchema.safeParse(limit);
    if (!parsed.success) {
      throw new RangeError(
        `Transfer concurrency limit must be an integer between ${minTransferConcurrency} and ${maxTransferConcurrency}.`,
      );
    }
    try {
      this.store.write(parsed.data);
    } catch (error) {
      this.onWarn('Could not save the transfer concurrency preference');
      throw new AccountError('PersistenceFailed', error);
    }
    this.concurrencyLimit = parsed.data;
    const settings = this.get();
    for (const listener of this.listeners) listener(settings);
    return settings;
  }

  subscribe(listener: (settings: TransferSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
