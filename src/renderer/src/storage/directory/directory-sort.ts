import { create } from 'zustand';
import type { DirectorySort } from './directory-types';

export const DIRECTORY_SORT_STORAGE_KEY = 'terra-commander:directory-sort';

const validFields = new Set<DirectorySort['field']>(['name', 'modifiedAt', 'size']);
const validDirections = new Set<DirectorySort['direction']>(['ascending', 'descending']);

export function toggleDirectorySort(
  previous: DirectorySort | null,
  field: DirectorySort['field'],
): DirectorySort {
  return {
    field,
    direction:
      previous?.field === field && previous.direction === 'ascending' ? 'descending' : 'ascending',
  };
}

export function parseDirectorySort(raw: string | null): DirectorySort | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { field, direction } = parsed as Record<string, unknown>;
    if (
      typeof field === 'string' &&
      validFields.has(field as DirectorySort['field']) &&
      typeof direction === 'string' &&
      validDirections.has(direction as DirectorySort['direction'])
    ) {
      return {
        field: field as DirectorySort['field'],
        direction: direction as DirectorySort['direction'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function getDefaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadDirectorySort(
  storage: Pick<Storage, 'getItem'> | null = getDefaultStorage(),
): DirectorySort | null {
  if (!storage) return null;
  try {
    return parseDirectorySort(storage.getItem(DIRECTORY_SORT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveDirectorySort(
  sort: DirectorySort | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = getDefaultStorage(),
): void {
  if (!storage) return;
  try {
    if (sort === null) {
      storage.removeItem(DIRECTORY_SORT_STORAGE_KEY);
    } else {
      storage.setItem(DIRECTORY_SORT_STORAGE_KEY, JSON.stringify(sort));
    }
  } catch {
    // Ignore storage write failures (e.g. quota exceeded or restricted storage).
  }
}

interface DirectorySortState {
  sort: DirectorySort | null;
  toggleSort: (field: DirectorySort['field']) => void;
}

export const useDirectorySortStore = create<DirectorySortState>((set) => ({
  sort: loadDirectorySort(),
  toggleSort: (field) =>
    set((state) => {
      const next = toggleDirectorySort(state.sort, field);
      saveDirectorySort(next);
      return { sort: next };
    }),
}));
