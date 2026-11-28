import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DirectoryRow } from '../directory-types';
import { matchDirectoryRows } from './directory-search';

interface DirectorySearchState {
  opened: boolean;
  query: string;
  locator: string | null;
  caseSensitive: boolean;
  useRegex: boolean;
}

export function useDirectorySearch(
  rows: readonly DirectoryRow[],
  onMatch: (locator: string | null) => void,
  onSelectAll: (locators: readonly string[], primaryLocator: string | null) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState<DirectorySearchState>({
    opened: false,
    query: '',
    locator: null,
    caseSensitive: false,
    useRegex: false,
  });
  const { matches, invalidPattern } = useMemo(
    () =>
      matchDirectoryRows(rows, search.query, {
        caseSensitive: search.caseSensitive,
        useRegex: search.useRegex,
      }),
    [rows, search.query, search.caseSensitive, search.useRegex],
  );
  const index = search.locator === null ? -1 : matches.indexOf(search.locator);
  if (index === -1 && (matches.length > 0 || search.locator !== null)) {
    setSearch({ ...search, locator: matches[0] ?? null });
  }

  useLayoutEffect(() => {
    if (search.opened && search.query) onMatch(search.locator);
  }, [search, onMatch]);

  const open = () => {
    setSearch((previous) =>
      previous.opened ? previous : { ...previous, opened: true, query: '', locator: null },
    );
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  };
  const navigate = (direction: -1 | 1) => {
    if (!search.opened || matches.length === 0) return;
    const next = (index + direction + matches.length) % matches.length;
    setSearch({ ...search, locator: matches[next] ?? null });
  };
  const selectAll = () => {
    if (!search.opened || matches.length === 0) return;
    onSelectAll(matches, search.locator ?? matches[0] ?? null);
  };

  return {
    opened: search.opened,
    inputRef,
    query: search.query,
    caseSensitive: search.caseSensitive,
    useRegex: search.useRegex,
    invalidPattern,
    index,
    total: matches.length,
    open,
    close: () => setSearch((previous) => ({ ...previous, opened: false })),
    changeQuery: (query: string) =>
      setSearch((previous) => ({ ...previous, opened: true, query, locator: null })),
    toggleCaseSensitive: () =>
      setSearch((previous) => ({ ...previous, caseSensitive: !previous.caseSensitive })),
    toggleRegex: () => setSearch((previous) => ({ ...previous, useRegex: !previous.useRegex })),
    navigate,
    selectAll,
  };
}

export type DirectorySearchController = ReturnType<typeof useDirectorySearch>;
