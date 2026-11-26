import type { DirectoryRow, DirectorySelectionModifiers } from './directory-types';

export interface DirectorySelectionState {
  locators: ReadonlySet<string>;
  anchor: string | null;
  active: string | null;
}

const emptyLocators: ReadonlySet<string> = new Set();

export function createEmptyDirectorySelection(): DirectorySelectionState {
  return {
    locators: emptyLocators,
    anchor: null,
    active: null,
  };
}

export function selectDirectoryEntry(
  current: DirectorySelectionState,
  rows: readonly DirectoryRow[],
  rowIndexByLocator: ReadonlyMap<string, number>,
  locator: string,
  { toggle, range }: DirectorySelectionModifiers,
): DirectorySelectionState {
  const end = rowIndexByLocator.get(locator) ?? -1;
  if (end < 0) return current;

  const start =
    range && current.anchor !== null ? (rowIndexByLocator.get(current.anchor) ?? -1) : -1;
  const anchor = start < 0 ? locator : current.anchor;
  if (start >= 0) {
    const locators = toggle ? new Set(current.locators) : new Set<string>();
    for (const { entry } of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) {
      locators.add(entry.ref.locator);
    }
    return { locators, anchor, active: locator };
  }
  if (!toggle) {
    return { locators: new Set([locator]), anchor, active: locator };
  }

  const locators = new Set(current.locators);
  if (!range && locators.has(locator)) locators.delete(locator);
  else locators.add(locator);
  return { locators, anchor, active: locator };
}

export function selectAllDirectoryEntries(
  current: DirectorySelectionState,
  rows: readonly DirectoryRow[],
  rowIndexByLocator: ReadonlyMap<string, number>,
): DirectorySelectionState {
  const firstLocator = rows[0]?.entry.ref.locator ?? null;
  const anchor =
    current.anchor !== null && rowIndexByLocator.has(current.anchor)
      ? current.anchor
      : firstLocator;
  const active =
    current.active !== null && rowIndexByLocator.has(current.active) ? current.active : null;
  return {
    locators: new Set(rows.map(({ entry }) => entry.ref.locator)),
    anchor,
    active,
  };
}

export function selectOnlyDirectoryEntry(locator: string | null): DirectorySelectionState {
  return {
    locators: locator === null ? emptyLocators : new Set([locator]),
    anchor: locator,
    active: locator,
  };
}

export function selectManyDirectoryEntries(
  locators: readonly string[],
  primaryLocator?: string | null,
): DirectorySelectionState {
  if (locators.length === 0) return createEmptyDirectorySelection();
  const nextLocators = new Set(locators);
  const lead =
    primaryLocator !== undefined && primaryLocator !== null && nextLocators.has(primaryLocator)
      ? primaryLocator
      : (locators[0] ?? null);
  return {
    locators: nextLocators,
    anchor: lead,
    active: lead,
  };
}

export function selectDirectoryEntryForContextMenu(
  current: DirectorySelectionState,
  locator: string,
): DirectorySelectionState {
  return {
    locators: current.locators.has(locator) ? current.locators : new Set([locator]),
    anchor: locator,
    active: locator,
  };
}

export function setActiveDirectoryEntry(
  current: DirectorySelectionState,
  locator: string | null,
): DirectorySelectionState {
  if (current.active === locator) return current;
  return { ...current, active: locator };
}

export function pruneDirectorySelection(
  current: DirectorySelectionState,
  entries: ReadonlyMap<string, unknown>,
): DirectorySelectionState {
  if (current.locators.size === 0 && current.anchor === null && current.active === null) {
    return current;
  }

  let locatorsChanged = false;
  for (const locator of current.locators) {
    if (!entries.has(locator)) {
      locatorsChanged = true;
      break;
    }
  }

  const nextAnchor = current.anchor !== null && entries.has(current.anchor) ? current.anchor : null;
  const nextActive = current.active !== null && entries.has(current.active) ? current.active : null;

  if (!locatorsChanged && nextAnchor === current.anchor && nextActive === current.active) {
    return current;
  }

  const nextLocators = locatorsChanged
    ? new Set([...current.locators].filter((locator) => entries.has(locator)))
    : current.locators;

  return {
    locators: nextLocators,
    anchor: nextAnchor,
    active: nextActive,
  };
}

export function migrateRenamedDirectorySelection(
  current: DirectorySelectionState,
  previousLocator: string,
  nextLocator: string,
): DirectorySelectionState {
  if (previousLocator === nextLocator) return current;

  const anchor = current.anchor === previousLocator ? nextLocator : current.anchor;
  const active = current.active === previousLocator ? nextLocator : current.active;
  const hasPrevious = current.locators.has(previousLocator);

  if (!hasPrevious && anchor === current.anchor && active === current.active) {
    return current;
  }

  if (!hasPrevious) {
    return { ...current, anchor, active };
  }

  const locators = new Set(current.locators);
  locators.delete(previousLocator);
  locators.add(nextLocator);
  return { locators, anchor, active };
}
