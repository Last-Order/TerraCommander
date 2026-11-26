import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DirectoryEntries } from './directory-cache';
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
import type {
  DirectoryRow,
  DirectorySelectionModifiers,
  DirectoryViewportCommand,
  DirectoryViewportRequest,
} from './directory-types';

export interface DirectoryListingProjection {
  entries: DirectoryEntries;
  ready: boolean;
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  canSort: boolean;
  loadingWithoutEntries: boolean;
  hasError: boolean;
}

export interface DirectoryViewState {
  entries: DirectoryEntries;
  rows: readonly DirectoryRow[];
  rowIndexByLocator: ReadonlyMap<string, number>;
  canSort: boolean;
  loadingWithoutEntries: boolean;
  hasError: boolean;
  navigationBlocked: boolean;
  selectedLocators: ReadonlySet<string>;
  anchorLocator: string | null;
  activeLocator: string | null;
  viewportCommand: DirectoryViewportCommand | null;
  syncListing: (projection: DirectoryListingProjection) => void;
  setNavigationBlocked: (blocked: boolean) => void;
  selectEntry: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  selectAll: () => void;
  selectOnly: (locator: string | null) => void;
  selectMany: (locators: readonly string[], primaryLocator?: string | null) => void;
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
  let lastPrunedEntries: DirectoryEntries | undefined =
    initial?.ready && initial.entries ? initial.entries : undefined;
  let viewportSequence = 0;

  return createStore<DirectoryViewState>((set) => ({
    entries: initial?.entries ?? emptyEntries,
    rows: initial?.rows ?? emptyRows,
    rowIndexByLocator: initial?.rowIndexByLocator ?? emptyIndexByLocator,
    canSort: initial?.canSort ?? false,
    loadingWithoutEntries: initial?.loadingWithoutEntries ?? false,
    hasError: initial?.hasError ?? false,
    navigationBlocked: false,
    selectedLocators: initialSelection.locators,
    anchorLocator: initialSelection.anchor,
    activeLocator: initialSelection.active,
    viewportCommand: null,

    syncListing: (projection) =>
      set((state) => {
        const listingChanged =
          state.entries !== projection.entries ||
          state.rows !== projection.rows ||
          state.rowIndexByLocator !== projection.rowIndexByLocator ||
          state.canSort !== projection.canSort ||
          state.loadingWithoutEntries !== projection.loadingWithoutEntries ||
          state.hasError !== projection.hasError;

        let selectionUpdate: Partial<DirectoryViewState> | null = null;
        if (projection.ready && lastPrunedEntries !== projection.entries) {
          lastPrunedEntries = projection.entries;
          const current = readSelection(state);
          const pruned = pruneDirectorySelection(current, projection.entries);
          selectionUpdate = selectionPatch(current, pruned);
        }

        if (!listingChanged && !selectionUpdate) return state;

        return {
          ...(listingChanged
            ? {
                entries: projection.entries,
                rows: projection.rows,
                rowIndexByLocator: projection.rowIndexByLocator,
                canSort: projection.canSort,
                loadingWithoutEntries: projection.loadingWithoutEntries,
                hasError: projection.hasError,
              }
            : {}),
          ...selectionUpdate,
        };
      }),

    setNavigationBlocked: (blocked) =>
      set((state) =>
        state.navigationBlocked === blocked ? state : { navigationBlocked: blocked },
      ),

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

    selectOnly: (locator) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectOnlyDirectoryEntry(locator);
        return selectionPatch(current, next) ?? state;
      }),

    selectMany: (locators, primaryLocator) =>
      set((state) => {
        const current = readSelection(state);
        const next = selectManyDirectoryEntries(locators, primaryLocator);
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
