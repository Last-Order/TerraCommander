import { useLayoutEffect, useMemo, useState } from 'react';
import type { DirectoryRow } from './directory-types';

interface DirectorySearchState {
  opened: boolean;
  query: string;
  locator: string | null;
}

export function useDirectorySearch(
  rows: readonly DirectoryRow[],
  onMatch: (locator: string | null) => void,
) {
  const [search, setSearch] = useState<DirectorySearchState>({
    opened: false,
    query: '',
    locator: null,
  });
  const keyword = search.query.toLowerCase();
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

  useLayoutEffect(() => {
    if (search.opened && search.query) onMatch(search.locator);
  }, [search, onMatch]);

  const revealTarget = useMemo(
    () => (!search.opened || search.locator === null ? null : { locator: search.locator }),
    [search],
  );
  const navigate = (direction: -1 | 1) => {
    if (!search.opened || matches.length === 0) return;
    const next = (index + direction + matches.length) % matches.length;
    setSearch({ ...search, locator: matches[next] ?? null });
  };

  return {
    opened: search.opened,
    query: search.query,
    index,
    total: matches.length,
    revealTarget,
    open: () =>
      setSearch((previous) =>
        previous.opened ? previous : { opened: true, query: '', locator: null },
      ),
    close: () => setSearch((previous) => ({ ...previous, opened: false })),
    changeQuery: (query: string) => setSearch({ opened: true, query, locator: null }),
    navigate,
  };
}
