import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_SORT_STORAGE_KEY,
  loadDirectorySort,
  saveDirectorySort,
  toggleDirectorySort,
} from './directory-sort';

function createMemoryStorage() {
  const map = new Map<string, string>();
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
  it('toggles sort direction and resets to ascending when switching fields', () => {
    const first = toggleDirectorySort(null, 'name');
    expect(first).toEqual({ field: 'name', direction: 'ascending' });
    expect(toggleDirectorySort(first, 'name')).toEqual({ field: 'name', direction: 'descending' });
    expect(toggleDirectorySort({ field: 'name', direction: 'descending' }, 'name')).toEqual({
      field: 'name',
      direction: 'ascending',
    });
    expect(toggleDirectorySort(first, 'size')).toEqual({ field: 'size', direction: 'ascending' });
  });

  it('persists sort state and ignores missing or malformed stored values', () => {
    const storage = createMemoryStorage();
    expect(loadDirectorySort(storage)).toBeNull();

    saveDirectorySort({ field: 'size', direction: 'descending' }, storage);
    expect(loadDirectorySort(storage)).toEqual({ field: 'size', direction: 'descending' });

    for (const invalid of [
      '',
      'not-json',
      '{"field":"unknown","direction":"ascending"}',
      '{"field":"name","direction":"up"}',
    ]) {
      storage.setItem(DIRECTORY_SORT_STORAGE_KEY, invalid);
      expect(loadDirectorySort(storage)).toBeNull();
    }
  });
});
