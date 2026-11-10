import type { Entry, EntryRef } from '../../../shared/storage';

export type DirectoryEntries = ReadonlyMap<string, Entry>;

const maxDirectories = 16;
const maxEntries = 20_000;

export function directoryKey({ connectionId, spaceId, locator }: EntryRef): string {
  return JSON.stringify([connectionId, spaceId, locator]);
}

export class DirectoryCache {
  private readonly directories = new Map<
    string,
    { connectionId: string; entries: DirectoryEntries }
  >();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private entryCount = 0;

  peek(ref: EntryRef): DirectoryEntries | undefined {
    return this.directories.get(directoryKey(ref))?.entries;
  }

  get(ref: EntryRef): DirectoryEntries | undefined {
    const key = directoryKey(ref);
    const directory = this.directories.get(key);
    if (directory) {
      this.directories.delete(key);
      this.directories.set(key, directory);
    }
    return directory?.entries;
  }

  save(ref: EntryRef, entries: DirectoryEntries): void {
    const key = directoryKey(ref);
    this.delete(key);
    if (entries.size > maxEntries) return;

    this.directories.set(key, { connectionId: ref.connectionId, entries });
    this.entryCount += entries.size;
    for (const oldest of this.directories.keys()) {
      if (this.directories.size <= maxDirectories && this.entryCount <= maxEntries) break;
      this.delete(oldest);
    }
  }

  version(connectionId: string): number {
    return this.versions.get(connectionId) ?? 0;
  }

  invalidateConnection(connectionId: string): void {
    this.versions.set(connectionId, this.version(connectionId) + 1);
    for (const [key, directory] of this.directories) {
      if (directory.connectionId === connectionId) this.delete(key);
    }
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private delete(key: string): void {
    const directory = this.directories.get(key);
    if (directory) {
      this.entryCount -= directory.entries.size;
      this.directories.delete(key);
    }
  }
}
