import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import { buildDirectoryRows } from './directory-rows';
import { createDirectoryViewStore } from './directory-view-store';

function createEntry(locator: string, name = locator): Entry {
  return {
    ref: { connectionId: 'local', spaceId: 'root', locator },
    name,
    kind: 'file',
    capabilities: {},
  };
}

function createProjection(locators: readonly string[], ready = true) {
  const entries = new Map<string, Entry>(
    locators.map((locator) => [locator, createEntry(locator)]),
  );
  const rows = buildDirectoryRows(entries, new Map(), null, 'en');
  return {
    entries,
    ready,
    rows,
  };
}

describe('createDirectoryViewStore', () => {
  it('syncs listing projection, indexes rows, and prunes removed entries only when ready', () => {
    const initial = createProjection(['a', 'b', 'c'], true);
    const store = createDirectoryViewStore(initial);

    expect(Array.from(store.getState().rowIndexByLocator.entries())).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);

    store.getState().selectOnly('a');
    store.getState().selectEntry('b', { toggle: true, range: false });
    expect([...store.getState().selectedLocators]).toEqual(['a', 'b']);
    expect(store.getState().activeLocator).toBe('b');

    // Non-ready listing update keeps existing selection intact while refreshing row indices.
    store.getState().syncListing(createProjection(['a'], false));
    expect(Array.from(store.getState().rowIndexByLocator.entries())).toEqual([['a', 0]]);
    expect([...store.getState().selectedLocators]).toEqual(['a', 'b']);
    expect(store.getState().activeLocator).toBe('b');

    // Ready listing update prunes removed locators, anchor, and active atomically.
    store.getState().syncListing(createProjection(['a', 'c'], true));
    expect(Array.from(store.getState().rowIndexByLocator.entries())).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
    expect([...store.getState().selectedLocators]).toEqual(['a']);
    expect(store.getState().anchorLocator).toBeNull();
    expect(store.getState().activeLocator).toBeNull();
  });

  it('sequences viewport commands and only clears matching sequence numbers', () => {
    const store = createDirectoryViewStore(createProjection(['a', 'b'], true));

    store.getState().requestViewport({ locator: 'a', align: 'center', focus: false });
    const first = store.getState().viewportCommand;
    expect(first).toEqual({ seq: 1, locator: 'a', align: 'center', focus: false });

    store.getState().requestViewport({ locator: 'a', align: 'auto', focus: true });
    const second = store.getState().viewportCommand;
    expect(second).toEqual({ seq: 2, locator: 'a', align: 'auto', focus: true });

    // Stale clear must not clobber the newer command.
    store.getState().clearViewportCommand(1);
    expect(store.getState().viewportCommand).toEqual(second);

    store.getState().clearViewportCommand(2);
    expect(store.getState().viewportCommand).toBeNull();
  });

  it('selects multiple entries with an optional primary locator', () => {
    const store = createDirectoryViewStore(createProjection(['a', 'b', 'c'], true));

    store.getState().selectMany(['a', 'c'], 'c');
    expect([...store.getState().selectedLocators]).toEqual(['a', 'c']);
    expect(store.getState().anchorLocator).toBe('c');
    expect(store.getState().activeLocator).toBe('c');

    store.getState().selectMany([]);
    expect(store.getState().selectedLocators.size).toBe(0);
    expect(store.getState().anchorLocator).toBeNull();
    expect(store.getState().activeLocator).toBeNull();
  });
});
