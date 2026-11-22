import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import { buildDirectoryRows } from './directory-rows';

function entry(locator: string, overrides: Partial<Entry> = {}): Entry {
  return {
    ref: { connectionId: 'local', spaceId: 'root', locator },
    kind: 'file',
    name: locator,
    capabilities: {},
    ...overrides,
  };
}

describe('buildDirectoryRows', () => {
  it('maps optimistic renames, timestamps, and omits directory sizes', () => {
    const entries = new Map<string, Entry>([
      [
        'dir',
        entry('dir', {
          kind: 'directory',
          name: 'folder',
          size: 4096,
          modifiedAt: '2026-01-02T03:04:05.000Z',
        }),
      ],
      ['file', entry('file', { name: 'notes.txt', size: 128, modifiedAt: 'not-a-date' })],
    ]);
    const optimisticNames = new Map<string, string>([['file', 'renamed.txt']]);

    const rows = buildDirectoryRows(entries, optimisticNames, null, 'en');

    expect(rows).toEqual([
      {
        entry: entries.get('dir'),
        name: 'folder',
        modifiedAt: Date.parse('2026-01-02T03:04:05.000Z'),
        size: undefined,
      },
      {
        entry: entries.get('file'),
        name: 'renamed.txt',
        modifiedAt: undefined,
        size: 128,
      },
    ]);
  });

  it('sorts by name numerically and keeps missing values last with name tie-breakers', () => {
    const entries = new Map<string, Entry>([
      ['b', entry('b', { name: 'file10.txt', size: 100 })],
      ['a', entry('a', { name: 'file2.txt', size: 200 })],
      ['d', entry('d', { kind: 'directory', name: 'beta' })],
      ['c', entry('c', { kind: 'directory', name: 'alpha' })],
    ]);

    expect(
      buildDirectoryRows(entries, new Map(), { field: 'name', direction: 'ascending' }, 'en').map(
        (row) => row.name,
      ),
    ).toEqual(['alpha', 'beta', 'file2.txt', 'file10.txt']);

    expect(
      buildDirectoryRows(entries, new Map(), { field: 'size', direction: 'descending' }, 'en').map(
        (row) => row.name,
      ),
    ).toEqual(['file2.txt', 'file10.txt', 'alpha', 'beta']);
  });
});
