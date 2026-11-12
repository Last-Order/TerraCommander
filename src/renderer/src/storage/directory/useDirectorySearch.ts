import { useEffect, useMemo, useState } from 'react';
import type { DirectoryRow } from './DirectoryTable';

interface DirectorySearchState {
  query: string | null;
  locator: string | null;
}

export function useDirectorySearch(
  rows: readonly DirectoryRow[],
  onMatch: (locator: string | null) => void,
) {
  const [search, setSearch] = useState<DirectorySearchState>({ query: null, locator: null });
  const keyword = search.query?.toLowerCase() ?? '';
  const matches = useMemo(
    () =>
      keyword
        ? rows
            .filter(({ name }) => name.toLowerCase().includes(keyword))
            .map(({ entry }) => entry.ref.locator)
        : [],
    [rows, keyword],
  );
  const index = search.locator === null ? -1 : matches.indexOf(search.locator);
  if (index === -1 && (matches.length > 0 || search.locator !== null)) {
    setSearch({ ...search, locator: matches[0] ?? null });
  }

  useEffect(() => {
    if (search.query) onMatch(search.locator);
  }, [search, onMatch]);

  const revealTarget = useMemo(
    () => (search.locator === null ? null : { locator: search.locator }),
    [search],
  );
  const navigate = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    const next = (index + direction + matches.length) % matches.length;
    setSearch({ ...search, locator: matches[next] ?? null });
  };

  return {
    query: search.query,
    index,
    total: matches.length,
    revealTarget,
    open: () =>
      setSearch((previous) => (previous.query === null ? { query: '', locator: null } : previous)),
    close: () => setSearch({ query: null, locator: null }),
    changeQuery: (query: string) => setSearch({ query, locator: null }),
    navigate,
  };
}
