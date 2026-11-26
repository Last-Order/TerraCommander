import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import { buildDirectoryRows, indexDirectoryRows } from './directory-rows';

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

  it('places directories before files across sort fields and keeps missing values last', () => {
    const entries = new Map<string, Entry>([
      [
        'b',
        entry('b', { name: 'a-file10.txt', size: 100, modifiedAt: '2026-01-03T00:00:00.000Z' }),
      ],
      ['a', entry('a', { name: 'a-file2.txt', size: 200, modifiedAt: '2026-01-01T00:00:00.000Z' })],
      ['e', entry('e', { name: 'a-file-nosize.txt' })],
      [
        'd',
        entry('d', { kind: 'directory', name: 'z-beta', modifiedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      [
        'c',
        entry('c', { kind: 'directory', name: 'z-alpha', modifiedAt: '2026-01-04T00:00:00.000Z' }),
      ],
    ]);

    expect(
      buildDirectoryRows(entries, new Map(), { field: 'name', direction: 'ascending' }, 'en').map(
        (row) => row.name,
      ),
    ).toEqual(['z-alpha', 'z-beta', 'a-file-nosize.txt', 'a-file2.txt', 'a-file10.txt']);

    expect(
      buildDirectoryRows(entries, new Map(), { field: 'name', direction: 'descending' }, 'en').map(
        (row) => row.name,
      ),
    ).toEqual(['z-beta', 'z-alpha', 'a-file10.txt', 'a-file2.txt', 'a-file-nosize.txt']);

    expect(
      buildDirectoryRows(entries, new Map(), { field: 'size', direction: 'descending' }, 'en').map(
        (row) => row.name,
      ),
    ).toEqual(['z-alpha', 'z-beta', 'a-file2.txt', 'a-file10.txt', 'a-file-nosize.txt']);

    expect(
      buildDirectoryRows(
        entries,
        new Map(),
        { field: 'modifiedAt', direction: 'ascending' },
        'en',
      ).map((row) => row.name),
    ).toEqual(['z-beta', 'z-alpha', 'a-file2.txt', 'a-file10.txt', 'a-file-nosize.txt']);
  });
});

describe('indexDirectoryRows', () => {
  it('maps each entry locator to its current row index', () => {
    const entries = new Map<string, Entry>([
      ['first', entry('first')],
      ['second', entry('second')],
      ['third', entry('third')],
    ]);
    const rows = buildDirectoryRows(entries, new Map(), null, 'en');

    expect(Array.from(indexDirectoryRows(rows).entries())).toEqual([
      ['first', 0],
      ['second', 1],
      ['third', 2],
    ]);
  });
});
