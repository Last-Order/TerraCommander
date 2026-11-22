import type { Entry } from '@shared/storage';
import type { DirectoryRow, DirectorySort } from './directory-types';

const collators = new Map<string, Intl.Collator>();

function getCollator(locale?: string): Intl.Collator {
  const key = locale ?? '';
  let collator = collators.get(key);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(key, collator);
  }
  return collator;
}

export function sortDirectoryRows(
  rows: DirectoryRow[],
  { field, direction }: DirectorySort,
  locale?: string,
) {
  const { compare } = getCollator(locale);
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
  optimisticNames: ReadonlyMap<string, string>,
  sort: DirectorySort | null,
  locale?: string,
): DirectoryRow[] {
  const rows = Array.from(entries.values(), (entry): DirectoryRow => {
    const modifiedAt = Date.parse(entry.modifiedAt ?? '');
    return {
      entry,
      name: optimisticNames.get(entry.ref.locator) ?? entry.name,
      modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
      size: entry.kind === 'directory' ? undefined : entry.size,
    };
  });
  if (sort) sortDirectoryRows(rows, sort, locale);
  return rows;
}
