import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIRECTORY_SORT,
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
  it('cycles non-default fields through ascending, descending, and back to default', () => {
    const sizeAsc = toggleDirectorySort(DEFAULT_DIRECTORY_SORT, 'size');
    expect(sizeAsc).toEqual({ field: 'size', direction: 'ascending' });

    const sizeDesc = toggleDirectorySort(sizeAsc, 'size');
    expect(sizeDesc).toEqual({ field: 'size', direction: 'descending' });

    expect(toggleDirectorySort(sizeDesc, 'size')).toEqual(DEFAULT_DIRECTORY_SORT);

    const modifiedAsc = toggleDirectorySort(sizeAsc, 'modifiedAt');
    expect(modifiedAsc).toEqual({ field: 'modifiedAt', direction: 'ascending' });

    const modifiedDesc = toggleDirectorySort(modifiedAsc, 'modifiedAt');
    expect(modifiedDesc).toEqual({ field: 'modifiedAt', direction: 'descending' });

    expect(toggleDirectorySort(modifiedDesc, 'modifiedAt')).toEqual(DEFAULT_DIRECTORY_SORT);
  });

  it('toggles the default name column between ascending and descending and resets to ascending on field switch', () => {
    const descending = toggleDirectorySort(DEFAULT_DIRECTORY_SORT, 'name');
    expect(descending).toEqual({ field: 'name', direction: 'descending' });
    expect(toggleDirectorySort(descending, 'name')).toEqual(DEFAULT_DIRECTORY_SORT);
    expect(toggleDirectorySort(descending, 'size')).toEqual({
      field: 'size',
      direction: 'ascending',
    });
  });

  it('persists sort state and falls back to default on missing or malformed values', () => {
    const storage = createMemoryStorage();
    expect(loadDirectorySort(storage)).toEqual(DEFAULT_DIRECTORY_SORT);

    saveDirectorySort({ field: 'size', direction: 'descending' }, storage);
    expect(loadDirectorySort(storage)).toEqual({ field: 'size', direction: 'descending' });

    for (const invalid of [
      '',
      'not-json',
      '{"field":"unknown","direction":"ascending"}',
      '{"field":"name","direction":"up"}',
    ]) {
      storage.setItem(DIRECTORY_SORT_STORAGE_KEY, invalid);
      expect(loadDirectorySort(storage)).toEqual(DEFAULT_DIRECTORY_SORT);
    }
  });
});
