import { expect, it } from 'vitest';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { DirectoryCache } from './directory-cache';

function root(spaceId: string): EntryRef {
  return { connectionId: 'connection', spaceId, locator: '.' };
}

it('keeps recently opened directory snapshots when the directory limit is reached', () => {
  const cache = new DirectoryCache();
  const entries = new Map<string, Entry>();
  for (let index = 0; index < 16; index++) cache.save(root(String(index)), entries);

  expect(cache.get(root('0'))).toBe(entries);
  cache.save(root('16'), entries);
  expect(cache.peek(root('0'))).toBe(entries);
  expect(cache.peek(root('1'))).toBeUndefined();
  expect(cache.peek(root('16'))).toBe(entries);
});

it('limits the total cached entries and discards a previous snapshot if its replacement is too large', () => {
  const cache = new DirectoryCache();
  const large = root('large');
  const small = root('small');
  const full = new Map<string, Entry>();
  for (let index = 0; index < 20_000; index++) {
    const locator = String(index);
    full.set(locator, {
      ref: { ...large, locator },
      kind: 'file',
      name: locator,
      capabilities: {},
    });
  }
  const file: Entry = {
    ref: { ...small, locator: 'file' },
    kind: 'file',
    name: 'file',
    capabilities: {},
  };
  const smallListing = new Map([['file', file]]);

  cache.save(small, smallListing);
  cache.save(large, full);
  expect(cache.peek(small)).toBeUndefined();
  expect(cache.peek(large)).toBe(full);

  const oversized = new Map(full).set('file', { ...file, ref: { ...large, locator: 'file' } });
  cache.save(large, oversized);
  cache.save(small, smallListing);
  expect(cache.peek(large)).toBeUndefined();
  expect(cache.peek(small)).toBe(smallListing);
});
