import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import type { DirectoryRow } from '../directory-types';
import { matchDirectoryRows } from './directory-search';

interface DirectorySearchState {
  opened: boolean;
  query: string;
  locator: string | null;
  caseSensitive: boolean;
  useRegex: boolean;
}

export interface UseDirectorySearchOptions {
  rows: readonly DirectoryRow[];
  onOpen?: () => void;
  onClose?: () => void;
  onMatch: (locator: string | null) => void;
  onSelectAll: (locators: readonly string[], primaryLocator: string | null) => void;
}

export function useDirectorySearch({
  rows,
  onOpen,
  onClose,
  onMatch,
  onSelectAll,
}: UseDirectorySearchOptions) {
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
    onOpen?.();
    setSearch((previous) =>
      previous.opened ? previous : { ...previous, opened: true, query: '', locator: null },
    );
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  };
  const close = () => {
    if (!search.opened) return;
    setSearch((previous) => ({ ...previous, opened: false }));
    onClose?.();
  };
  const toggleCaseSensitive = () =>
    setSearch((previous) => ({ ...previous, caseSensitive: !previous.caseSensitive }));
  const toggleRegex = () =>
    setSearch((previous) => ({ ...previous, useRegex: !previous.useRegex }));
  const navigate = (direction: -1 | 1) => {
    if (!search.opened || matches.length === 0) return;
    const next = (index + direction + matches.length) % matches.length;
    setSearch({ ...search, locator: matches[next] ?? null });
  };
  const selectAll = () => {
    if (!search.opened || matches.length === 0) return;
    onSelectAll(matches, search.locator ?? matches[0] ?? null);
  };

  useKeyboardShortcuts([
    { key: 'f', ctrlKey: true, allowInEditable: true, onTrigger: open },
    ...(search.opened
      ? [
          { key: 'Escape', allowInEditable: true, onTrigger: close },
          { key: 'c', altKey: true, allowInEditable: true, onTrigger: toggleCaseSensitive },
          { key: 'r', altKey: true, allowInEditable: true, onTrigger: toggleRegex },
        ]
      : []),
  ]);

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
    close,
    changeQuery: (query: string) =>
      setSearch((previous) => ({ ...previous, opened: true, query, locator: null })),
    toggleCaseSensitive,
    toggleRegex,
    navigate,
    selectAll,
  };
}

export type DirectorySearchController = ReturnType<typeof useDirectorySearch>;
