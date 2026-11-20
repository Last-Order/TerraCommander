import type { Entry } from '@shared/storage';
import type { PendingEntryEffect } from '../tasks/pending-entry-effects';
import type { DirectoryRow, DirectorySort } from './directory-types';

export function sortDirectoryRows(
  rows: DirectoryRow[],
  { field, direction }: DirectorySort,
  locale?: string,
) {
  const { compare } = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const order = direction === 'ascending' ? 1 : -1;

  rows.sort((a, b) => {
    if (field === 'name') return compare(a.name, b.name) * order;
    const left = a[field];
    const right = b[field];
    if (left === undefined) return right === undefined ? compare(a.name, b.name) : 1;
    if (right === undefined) return -1;
    return (left - right) * order || compare(a.name, b.name);
  });
}

export function buildDirectoryRows(
  entries: ReadonlyMap<string, Entry>,
  pendingEntries: ReadonlyMap<string, PendingEntryEffect>,
  sort: DirectorySort | null,
  locale?: string,
): DirectoryRow[] {
  const rows = Array.from(entries.values(), (entry): DirectoryRow => {
    const modifiedAt = Date.parse(entry.modifiedAt ?? '');
    const pending = pendingEntries.get(entry.ref.locator);
    return {
      entry,
      name: pending?.optimisticName ?? entry.name,
      disabled: pending?.busy === true,
      modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
      size: entry.kind === 'directory' ? undefined : entry.size,
    };
  });
  if (sort) sortDirectoryRows(rows, sort, locale);
  return rows;
}
