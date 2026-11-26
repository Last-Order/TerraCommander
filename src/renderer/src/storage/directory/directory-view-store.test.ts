import { describe, expect, it } from 'vitest';
import type { Entry } from '@shared/storage';
import { buildDirectoryRows, indexDirectoryRows } from './directory-rows';
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
    rowIndexByLocator: indexDirectoryRows(rows),
    canSort: ready,
    loadingWithoutEntries: !ready && entries.size === 0,
    hasError: false,
  };
}

describe('createDirectoryViewStore', () => {
  it('syncs listing projection and prunes removed entries only when ready', () => {
    const initial = createProjection(['a', 'b', 'c'], true);
    const store = createDirectoryViewStore(initial);

    store.getState().selectMany(['a', 'b'], 'b');
    expect([...store.getState().selectedLocators]).toEqual(['a', 'b']);
    expect(store.getState().activeLocator).toBe('b');

    // Non-ready listing update keeps existing selection intact.
    store.getState().syncListing(createProjection(['a'], false));
    expect([...store.getState().selectedLocators]).toEqual(['a', 'b']);
    expect(store.getState().activeLocator).toBe('b');

    // Ready listing update prunes removed locators, anchor, and active atomically.
    store.getState().syncListing(createProjection(['a', 'c'], true));
    expect([...store.getState().selectedLocators]).toEqual(['a']);
    expect(store.getState().anchorLocator).toBeNull();
    expect(store.getState().activeLocator).toBeNull();
  });

  it('migrates renamed selection, anchor, and active locators', () => {
    const store = createDirectoryViewStore(createProjection(['a', 'b'], true));
    store.getState().selectOnly('b');
    store.getState().migrateRename('b', 'b-renamed');

    expect([...store.getState().selectedLocators]).toEqual(['b-renamed']);
    expect(store.getState().anchorLocator).toBe('b-renamed');
    expect(store.getState().activeLocator).toBe('b-renamed');
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
});
