import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { deferred } from '@main/testing/deferred';
import * as downloadPaths from './download-paths';
import { DownloadPreferences } from './download-preferences';

it('persists a validated directory and preserves it when the system default changes', async () => {
  await using temporary = await mkdtempDisposable(join(tmpdir(), 'terra-download-settings-'));
  let saved: unknown;
  const store = {
    read: () => saved,
    write: (value: string) => {
      saved = value;
    },
  };
  const preferences = new DownloadPreferences('system-downloads', store);
  expect(preferences.get().directory).toBe('system-downloads');
  const custom = await preferences.set(temporary.path);
  expect(new DownloadPreferences('new-system-default', store).get().directory).toBe(
    custom.directory,
  );
  await expect(preferences.set('relative')).rejects.toMatchObject({
    code: 'InvalidDownloadDirectory',
  });
  expect(preferences.get()).toEqual(custom);
});

it('prevents an older path validation from overwriting the latest setting', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  vi.spyOn(downloadPaths, 'downloadDirectory')
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  let saved = 'previous';
  const write = (directory: string) => {
    saved = directory;
  };
  const preferences = new DownloadPreferences('system-downloads', { read: () => saved, write });
  const older = preferences.set('first');
  const newer = preferences.set('second');
  second.resolve('latest');
  await newer;
  first.resolve('stale');
  await older;
  expect(preferences.get().directory).toBe('latest');
});
