import { entryKey, type EntryRef } from '@shared/storage';
import type { StorageDirectoryEffects } from '@shared/tasks';

const emptyRenames: ReadonlyMap<string, string> = new Map();

function sameRenames(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [locator, name] of left) {
    if (right.get(locator) !== name) return false;
  }
  return true;
}

function addKeyedListener(
  registry: Map<string, Set<() => void>>,
  key: string,
  listener: () => void,
): () => void {
  let listeners = registry.get(key);
  if (!listeners) {
    listeners = new Set();
    registry.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const active = registry.get(key);
    if (!active) return;
    active.delete(listener);
    if (active.size === 0) registry.delete(key);
  };
}

/** Tracks pending entry locks and optimistic renames independently of task progress updates. */
export class DirectoryEffectsStore {
  private busyKeys = new Set<string>();
  private renamesByDirectory = new Map<string, ReadonlyMap<string, string>>();
  private readonly entryListeners = new Map<string, Set<() => void>>();
  private readonly directoryRenameListeners = new Map<string, Set<() => void>>();
  private readonly busyListeners = new Set<() => void>();

  isBusy(ref: EntryRef): boolean {
    return this.busyKeys.has(entryKey(ref));
  }

  hasBusyEntries(entries: readonly { ref: EntryRef }[]): boolean {
    return entries.some(({ ref }) => this.busyKeys.has(entryKey(ref)));
  }

  getDirectoryRenames(parent: EntryRef): ReadonlyMap<string, string> {
    return this.renamesByDirectory.get(entryKey(parent)) ?? emptyRenames;
  }

  subscribeEntry(ref: EntryRef, listener: () => void): () => void {
    return addKeyedListener(this.entryListeners, entryKey(ref), listener);
  }

  subscribeDirectoryRenames(parent: EntryRef, listener: () => void): () => void {
    return addKeyedListener(this.directoryRenameListeners, entryKey(parent), listener);
  }

  subscribeBusy = (listener: () => void): (() => void) => {
    this.busyListeners.add(listener);
    return () => {
      this.busyListeners.delete(listener);
    };
  };

  apply(effects: StorageDirectoryEffects): void {
    const nextBusy = new Set<string>();
    for (const ref of effects.busyEntries) nextBusy.add(entryKey(ref));
    for (const rename of effects.renames) nextBusy.add(entryKey(rename.entry));

    const changedBusyKeys: string[] = [];
    for (const key of this.busyKeys) {
      if (!nextBusy.has(key)) changedBusyKeys.push(key);
    }
    for (const key of nextBusy) {
      if (!this.busyKeys.has(key)) changedBusyKeys.push(key);
    }

    const nextRenames = new Map<string, Map<string, string>>();
    for (const rename of effects.renames) {
      const dirKey = entryKey(rename.parent);
      let directory = nextRenames.get(dirKey);
      if (!directory) {
        directory = new Map();
        nextRenames.set(dirKey, directory);
      }
      directory.set(rename.entry.locator, rename.name);
    }

    const changedDirectories: string[] = [];
    const updatedRenames = new Map<string, ReadonlyMap<string, string>>();
    for (const [dirKey, nextMap] of nextRenames) {
      const previous = this.renamesByDirectory.get(dirKey);
      if (previous && sameRenames(previous, nextMap)) {
        updatedRenames.set(dirKey, previous);
      } else {
        updatedRenames.set(dirKey, nextMap);
        changedDirectories.push(dirKey);
      }
    }
    for (const dirKey of this.renamesByDirectory.keys()) {
      if (!nextRenames.has(dirKey)) changedDirectories.push(dirKey);
    }

    this.busyKeys = nextBusy;
    this.renamesByDirectory = updatedRenames;

    if (changedBusyKeys.length > 0) {
      for (const key of changedBusyKeys) {
        const listeners = this.entryListeners.get(key);
        if (listeners) {
          for (const listener of [...listeners]) listener();
        }
      }
      for (const listener of [...this.busyListeners]) listener();
    }

    for (const dirKey of changedDirectories) {
      const listeners = this.directoryRenameListeners.get(dirKey);
      if (listeners) {
        for (const listener of [...listeners]) listener();
      }
    }
  }
}
