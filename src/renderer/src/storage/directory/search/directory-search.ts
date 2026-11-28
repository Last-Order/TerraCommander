import type { DirectoryRow } from '../directory-types';

export interface DirectorySearchOptions {
  caseSensitive: boolean;
  useRegex: boolean;
}

export interface DirectorySearchResult {
  matches: readonly string[];
  invalidPattern: boolean;
}

export function matchDirectoryRows(
  rows: readonly DirectoryRow[],
  query: string,
  { caseSensitive, useRegex }: DirectorySearchOptions,
): DirectorySearchResult {
  if (query.length === 0) {
    return { matches: [], invalidPattern: false };
  }

  if (useRegex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, caseSensitive ? '' : 'i');
    } catch {
      return { matches: [], invalidPattern: true };
    }
    return {
      matches: rows.filter(({ name }) => pattern.test(name)).map(({ entry }) => entry.ref.locator),
      invalidPattern: false,
    };
  }

  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = rows
    .filter(({ name }) => (caseSensitive ? name : name.toLowerCase()).includes(needle))
    .map(({ entry }) => entry.ref.locator);
  return { matches, invalidPattern: false };
}
