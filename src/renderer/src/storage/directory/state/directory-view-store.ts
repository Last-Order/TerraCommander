import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  DirectoryRow,
  DirectorySelectionModifiers,
  DirectoryViewportCommand,
  DirectoryViewportRequest,
} from '../directory-types';
import type { DirectoryEntries } from './directory-cache';
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
  type DirectorySelectionState,
} from './directory-selection';

export interface DirectoryListingProjection {
  entries: DirectoryEntries;
  ready: boolean;
  rows: readonly DirectoryRow[];
}

export interface DirectoryViewState {
  entries: DirectoryEntries;
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  selectedLocators: ReadonlySet<string>;
  anchorLocator: string | null;
  activeLocator: string | null;
  viewportCommand: DirectoryViewportCommand | null;
  syncListing: (projection: DirectoryListingProjection) => void;
  selectEntry: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  selectAll: () => void;
  selectMany: (locators: readonly string[], primaryLocator?: string | null) => void;
  selectOnly: (locator: string | null) => void;
  selectForContextMenu: (locator: string) => void;
  setActiveLocator: (locator: string | null) => void;
  migrateRename: (previousLocator: string, nextLocator: string) => void;
  requestViewport: (request: DirectoryViewportRequest) => void;
  clearViewportCommand: (seq: number) => void;
}

export type DirectoryViewStore = StoreApi<DirectoryViewState>;

const emptyEntries: DirectoryEntries = new Map();
const emptyRows: readonly DirectoryRow[] = [];
const emptyIndexByLocator: ReadonlyMap<string, number> = new Map();

function readSelection(state: DirectoryViewState): DirectorySelectionState {
  return {
    locators: state.selectedLocators,
    anchor: state.anchorLocator,
    active: state.activeLocator,
  };
}

function selectionPatch(
  current: DirectorySelectionState,
  next: DirectorySelectionState,
): Partial<DirectoryViewState> | null {
  if (
    next === current ||
    (next.locators === current.locators &&
      next.anchor === current.anchor &&
      next.active === current.active)
  ) {
    return null;
  }
  return {
    selectedLocators: next.locators,
    anchorLocator: next.anchor,
    activeLocator: next.active,
  };
}

export function createDirectoryViewStore(
  initial?: Partial<DirectoryListingProjection>,
): DirectoryViewStore {
  const initialSelection = createEmptyDirectorySelection();
  const initialRows = initial?.rows ?? emptyRows;
  let lastPrunedEntries: DirectoryEntries | undefined =
    initial?.ready && initial.entries ? initial.entries : undefined;
  let viewportSequence = 0;

  return createStore<DirectoryViewState>((set) => ({
    entries: initial?.entries ?? emptyEntries,
    rows: initialRows,
    rowIndexByLocator:
      initialRows.length > 0 ? indexDirectoryRows(initialRows) : emptyIndexByLocator,
    selectedLocators: initialSelection.locators,
    anchorLocator: initialSelection.anchor,
    activeLocator: initialSelection.active,
    viewportCommand: null,

    syncListing: (projection) =>
      set((state) => {
        const entriesChanged = state.entries !== projection.entries;
        const rowsChanged = state.rows !== projection.rows;

        let selectionUpdate: Partial<DirectoryViewState> | null = null;
        if (projection.ready && lastPrunedEntries !== projection.entries) {
          lastPrunedEntries = projection.entries;
          const current = readSelection(state);
          const pruned = pruneDirectorySelection(current, projection.entries);
          selectionUpdate = selectionPatch(current, pruned);
        }

        if (!entriesChanged && !rowsChanged && !selectionUpdate) return state;

        return {
          ...(entriesChanged ? { entries: projection.entries } : {}),
          ...(rowsChanged
            ? {
                rows: projection.rows,
                rowIndexByLocator:
                  projection.rows.length > 0
                    ? indexDirectoryRows(projection.rows)
                    : emptyIndexByLocator,
              }
            : {}),
          ...selectionUpdate,
        };
      }),

    selectEntry: (locator, modifiers) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectDirectoryEntry(
          current,
          state.rows,
          state.rowIndexByLocator,
          locator,
          modifiers,
        );
        return selectionPatch(current, next) ?? state;
      }),

    selectAll: () =>
      set((state) => {
        const current = readSelection(state);
        const next = selectAllDirectoryEntries(current, state.rows, state.rowIndexByLocator);
        return selectionPatch(current, next) ?? state;
      }),

    selectMany: (locators, primaryLocator) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectManyDirectoryEntries(locators, primaryLocator);
        return selectionPatch(current, next) ?? state;
      }),

    selectOnly: (locator) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectOnlyDirectoryEntry(locator);
        return selectionPatch(current, next) ?? state;
      }),

    selectForContextMenu: (locator) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectDirectoryEntryForContextMenu(current, locator);
        return selectionPatch(current, next) ?? state;
      }),

    setActiveLocator: (locator) =>
      set((state) => {
        const current = readSelection(state);
        const next = setActiveDirectoryEntry(current, locator);
        return selectionPatch(current, next) ?? state;
      }),

    migrateRename: (previousLocator, nextLocator) =>
      set((state) => {
        const current = readSelection(state);
        const next = migrateRenamedDirectorySelection(current, previousLocator, nextLocator);
        return selectionPatch(current, next) ?? state;
      }),

    requestViewport: ({ locator, align = 'auto', focus = false }) => {
      viewportSequence += 1;
      set({
        viewportCommand: {
          seq: viewportSequence,
          locator,
          align,
          focus,
        },
      });
    },

    clearViewportCommand: (seq) =>
      set((state) => (state.viewportCommand?.seq === seq ? { viewportCommand: null } : state)),
  }));
}
