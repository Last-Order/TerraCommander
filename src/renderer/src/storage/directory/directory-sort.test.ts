import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_SORT_STORAGE_KEY,
  loadDirectorySort,
  parseDirectorySort,
  saveDirectorySort,
  toggleDirectorySort,
} from './directory-sort';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe('directory-sort', () => {
  it('toggles sort field and direction', () => {
    const first = toggleDirectorySort(null, 'name');
    expect(first).toEqual({ field: 'name', direction: 'ascending' });

    const second = toggleDirectorySort(first, 'name');
    expect(second).toEqual({ field: 'name', direction: 'descending' });

    const third = toggleDirectorySort(second, 'name');
    expect(third).toEqual({ field: 'name', direction: 'ascending' });

    const switched = toggleDirectorySort(first, 'size');
    expect(switched).toEqual({ field: 'size', direction: 'ascending' });
  });

  it('parses valid sort payloads and rejects invalid ones', () => {
    expect(parseDirectorySort(null)).toBeNull();
    expect(parseDirectorySort('')).toBeNull();
    expect(parseDirectorySort('not-json')).toBeNull();
    expect(parseDirectorySort('{"field":"unknown","direction":"ascending"}')).toBeNull();
    expect(parseDirectorySort('{"field":"name","direction":"up"}')).toBeNull();
    expect(parseDirectorySort('{"field":"modifiedAt","direction":"descending"}')).toEqual({
      field: 'modifiedAt',
      direction: 'descending',
    });
  });

  it('persists and reloads sort state from storage', () => {
    const storage = createMemoryStorage();
    expect(loadDirectorySort(storage)).toBeNull();

    saveDirectorySort({ field: 'size', direction: 'descending' }, storage);
    expect(storage.getItem(DIRECTORY_SORT_STORAGE_KEY)).toBe(
      JSON.stringify({ field: 'size', direction: 'descending' }),
    );
    expect(loadDirectorySort(storage)).toEqual({ field: 'size', direction: 'descending' });

    saveDirectorySort(null, storage);
    expect(loadDirectorySort(storage)).toBeNull();
  });
});
