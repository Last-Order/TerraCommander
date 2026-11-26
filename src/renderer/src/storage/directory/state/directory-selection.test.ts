import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import type { DirectoryRow } from '../directory-types';
import { indexDirectoryRows } from './directory-rows';
import {
  createEmptyDirectorySelection,
  migrateRenamedDirectorySelection,
  pruneDirectorySelection,
  selectAllDirectoryEntries,
  selectDirectoryEntry,
  selectDirectoryEntryForContextMenu,
  selectManyDirectoryEntries,
  selectOnlyDirectoryEntry,
  setActiveDirectoryEntry,
} from './directory-selection';

function createRow(locator: string, name = locator): DirectoryRow {
  const entry: Entry = {
    ref: { connectionId: 'local', spaceId: 'root', locator },
    name,
    kind: 'file',
    capabilities: {},
  };
  return { entry, name, modifiedAt: undefined, size: undefined };
}

const rows = [createRow('a'), createRow('b'), createRow('c'), createRow('d')];
const rowIndexByLocator = indexDirectoryRows(rows);

describe('directory-selection', () => {
  it('selects single, toggled, and range entries while updating anchor and active', () => {
    const empty = createEmptyDirectorySelection();

    const single = selectDirectoryEntry(empty, rows, rowIndexByLocator, 'b', {
      toggle: false,
      range: false,
    });
    expect([...single.locators]).toEqual(['b']);
    expect(single.anchor).toBe('b');
    expect(single.active).toBe('b');

    const ranged = selectDirectoryEntry(single, rows, rowIndexByLocator, 'd', {
      toggle: false,
      range: true,
    });
    expect([...ranged.locators]).toEqual(['b', 'c', 'd']);
    expect(ranged.anchor).toBe('b');
    expect(ranged.active).toBe('d');

    const toggledOff = selectDirectoryEntry(ranged, rows, rowIndexByLocator, 'c', {
      toggle: true,
      range: false,
    });
    expect([...toggledOff.locators]).toEqual(['b', 'd']);
    expect(toggledOff.anchor).toBe('c');
    expect(toggledOff.active).toBe('c');

    const toggledRange = selectDirectoryEntry(toggledOff, rows, rowIndexByLocator, 'a', {
      toggle: true,
      range: true,
    });
    expect([...toggledRange.locators]).toEqual(['b', 'd', 'a', 'c']);
    expect(toggledRange.anchor).toBe('c');
    expect(toggledRange.active).toBe('a');
  });

  it('ignores unknown locators in selectDirectoryEntry', () => {
    const initial = selectOnlyDirectoryEntry('b');
    expect(
      selectDirectoryEntry(initial, rows, rowIndexByLocator, 'missing', {
        toggle: false,
        range: false,
      }),
    ).toBe(initial);
  });

  it('selects all entries while preserving valid anchor and active', () => {
    const initial = { locators: new Set(['b']), anchor: 'b', active: 'c' };
    const all = selectAllDirectoryEntries(initial, rows, rowIndexByLocator);
    expect([...all.locators]).toEqual(['a', 'b', 'c', 'd']);
    expect(all.anchor).toBe('b');
    expect(all.active).toBe('c');

    const fallback = selectAllDirectoryEntries(
      createEmptyDirectorySelection(),
      rows,
      rowIndexByLocator,
    );
    expect([...fallback.locators]).toEqual(['a', 'b', 'c', 'd']);
    expect(fallback.anchor).toBe('a');
    expect(fallback.active).toBeNull();
  });

  it('supports selectMany with explicit or default primary locator', () => {
    const batch = selectManyDirectoryEntries(['c', 'a', 'b'], 'a');
    expect([...batch.locators]).toEqual(['c', 'a', 'b']);
    expect(batch.anchor).toBe('a');
    expect(batch.active).toBe('a');

    const fallbackLead = selectManyDirectoryEntries(['c', 'b'], 'missing');
    expect(fallbackLead.anchor).toBe('c');
    expect(fallbackLead.active).toBe('c');

    const empty = selectManyDirectoryEntries([]);
    expect(empty.locators.size).toBe(0);
    expect(empty.anchor).toBeNull();
    expect(empty.active).toBeNull();
  });

  it('preserves multi-selection on context menu for selected entry and replaces otherwise', () => {
    const multi = selectManyDirectoryEntries(['a', 'b'], 'a');
    const kept = selectDirectoryEntryForContextMenu(multi, 'b');
    expect([...kept.locators]).toEqual(['a', 'b']);
    expect(kept.anchor).toBe('b');
    expect(kept.active).toBe('b');

    const replaced = selectDirectoryEntryForContextMenu(multi, 'd');
    expect([...replaced.locators]).toEqual(['d']);
    expect(replaced.anchor).toBe('d');
    expect(replaced.active).toBe('d');
  });

  it('updates active locator without mutating selection and preserves reference when unchanged', () => {
    const initial = selectOnlyDirectoryEntry('a');
    expect(setActiveDirectoryEntry(initial, 'a')).toBe(initial);

    const moved = setActiveDirectoryEntry(initial, 'c');
    expect([...moved.locators]).toEqual(['a']);
    expect(moved.anchor).toBe('a');
    expect(moved.active).toBe('c');
  });

  it('atomically prunes missing locators, anchor, and active', () => {
    const entries = new Map<string, Entry>([
      ['a', rows[0]!.entry],
      ['c', rows[2]!.entry],
    ]);
    const initial = { locators: new Set(['a', 'b']), anchor: 'b', active: 'b' };
    const pruned = pruneDirectorySelection(initial, entries);
    expect([...pruned.locators]).toEqual(['a']);
    expect(pruned.anchor).toBeNull();
    expect(pruned.active).toBeNull();

    expect(pruneDirectorySelection(pruned, entries)).toBe(pruned);
  });

  it('atomically migrates locators, anchor, and active on rename', () => {
    const initial = { locators: new Set(['a', 'b']), anchor: 'b', active: 'b' };
    const migrated = migrateRenamedDirectorySelection(initial, 'b', 'b-renamed');
    expect([...migrated.locators]).toEqual(['a', 'b-renamed']);
    expect(migrated.anchor).toBe('b-renamed');
    expect(migrated.active).toBe('b-renamed');

    expect(migrateRenamedDirectorySelection(initial, 'z', 'z-renamed')).toBe(initial);
    expect(migrateRenamedDirectorySelection(initial, 'b', 'b')).toBe(initial);

    const activeOnly = { locators: new Set(['a']), anchor: 'a', active: 'b' };
    const migratedActive = migrateRenamedDirectorySelection(activeOnly, 'b', 'b-renamed');
    expect(migratedActive.locators).toBe(activeOnly.locators);
    expect(migratedActive.anchor).toBe('a');
    expect(migratedActive.active).toBe('b-renamed');
  });
});
