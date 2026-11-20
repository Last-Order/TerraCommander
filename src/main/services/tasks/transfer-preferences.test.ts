import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultTransferConcurrency,
  maxTransferConcurrency,
  minTransferConcurrency,
} from '@shared/tasks';
import { createDesktopTransferPreferences } from './desktop-transfer-preferences';
import { TransferPreferences } from './transfer-preferences';

describe('transfer preferences', () => {
  it('defaults to the built-in concurrency limit and ignores invalid stored values', () => {
    const onWarn = vi.fn();
    expect(
      new TransferPreferences({ read: () => undefined, write: () => {} }, onWarn).get(),
    ).toEqual({
      concurrencyLimit: defaultTransferConcurrency,
    });
    expect(new TransferPreferences({ read: () => 0, write: () => {} }, onWarn).get()).toEqual({
      concurrencyLimit: defaultTransferConcurrency,
    });
    expect(
      new TransferPreferences(
        { read: () => maxTransferConcurrency + 1, write: () => {} },
        onWarn,
      ).get(),
    ).toEqual({
      concurrencyLimit: defaultTransferConcurrency,
    });
    expect(new TransferPreferences({ read: () => '8', write: () => {} }, onWarn).get()).toEqual({
      concurrencyLimit: defaultTransferConcurrency,
    });
  });

  it('persists valid limits, notifies subscribers, and preserves state on write failure', () => {
    let saved: unknown = 4;
    let failWrites = false;
    const onWarn = vi.fn();
    const preferences = new TransferPreferences(
      {
        read: () => saved,
        write: (value) => {
          if (failWrites) throw new Error('disk full');
          saved = value;
        },
      },
      onWarn,
    );
    expect(preferences.get()).toEqual({ concurrencyLimit: 4 });

    const listener = vi.fn();
    const unsubscribe = preferences.subscribe(listener);

    expect(preferences.setConcurrencyLimit(minTransferConcurrency)).toEqual({
      concurrencyLimit: minTransferConcurrency,
    });
    expect(preferences.setConcurrencyLimit(maxTransferConcurrency)).toEqual({
      concurrencyLimit: maxTransferConcurrency,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({ concurrencyLimit: maxTransferConcurrency });

    expect(() => preferences.setConcurrencyLimit(0)).toThrow(RangeError);
    expect(() => preferences.setConcurrencyLimit(maxTransferConcurrency + 1)).toThrow(RangeError);
    expect(() => preferences.setConcurrencyLimit(2.5)).toThrow(RangeError);

    failWrites = true;
    expect(() => preferences.setConcurrencyLimit(6)).toThrow(
      expect.objectContaining({ code: 'PersistenceFailed' }),
    );
    expect(preferences.get()).toEqual({ concurrencyLimit: maxTransferConcurrency });
    expect(onWarn).toHaveBeenCalledTimes(1);

    unsubscribe();
    failWrites = false;
    preferences.setConcurrencyLimit(12);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('restores a saved limit across desktop store restarts', async () => {
    await using profile = await mkdtempDisposable(join(tmpdir(), 'terra-transfer-settings-'));
    const initial = createDesktopTransferPreferences(profile.path);
    expect(initial.get()).toEqual({ concurrencyLimit: defaultTransferConcurrency });
    expect(initial.setConcurrencyLimit(16)).toEqual({ concurrencyLimit: 16 });

    const restarted = createDesktopTransferPreferences(profile.path);
    expect(restarted.get()).toEqual({ concurrencyLimit: 16 });
  });
});
