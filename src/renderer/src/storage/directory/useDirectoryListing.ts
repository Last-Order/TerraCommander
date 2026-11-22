import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { entryKey, type Entry } from '@shared/storage';
import { errorKey, resultOf, StorageBrowserError, type StorageErrorKey } from '../storage-client';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useCurrentDirectory } from './current-directory-context';
import {
  addDirectoryEntry,
  removeDirectoryEntry,
  replaceRenamedEntry,
  type DirectoryEntries,
} from './directory-cache';

export type DirectoryListingPhase = 'loading' | 'ready' | 'refreshing' | 'error';

type ListingState =
  | { phase: Exclude<DirectoryListingPhase, 'error'>; entries: DirectoryEntries }
  | {
      phase: 'error';
      entries: DirectoryEntries;
      snapshot: DirectoryEntries | undefined;
      error: StorageErrorKey;
    };

interface ListingOptions {
  cacheable: boolean;
  version: number;
}

const emptyEntries: DirectoryEntries = new Map();

function listingSnapshot(listing: ListingState): DirectoryEntries | undefined {
  if (listing.phase === 'error') return listing.snapshot;
  if (listing.phase === 'loading') return undefined;
  return listing.entries;
}

export function useDirectoryListing({ cacheable, version }: ListingOptions) {
  const { directoryCache: cache, onAuthRequired } = useStorageWorkspace();
  const { ref: parent } = useCurrentDirectory();
  const [listing, setListing] = useState<ListingState>(() => {
    const cached = cacheable ? cache.peek(parent) : undefined;
    return cached
      ? { phase: 'ready', entries: cached }
      : { phase: 'loading', entries: emptyEntries };
  });
  const currentRequest = useRef<{ additions: Map<string, Entry> } | null>(null);

  const load = useCallback(
    async (previous?: DirectoryEntries) => {
      if (cache.version(parent.connectionId) !== version) return;
      const request = { additions: currentRequest.current?.additions ?? new Map<string, Entry>() };
      currentRequest.current = request;
      const isCurrent = () =>
        currentRequest.current === request && cache.version(parent.connectionId) === version;
      const withAdditions = (listed: DirectoryEntries) => {
        if (!request.additions.size) return listed;
        const updated = new Map(listed);
        for (const [locator, entry] of request.additions) updated.set(locator, entry);
        return updated;
      };

      setListing({ phase: previous ? 'refreshing' : 'loading', entries: previous ?? emptyEntries });
      const entries = new Map<string, Entry>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      try {
        do {
          const page = await resultOf(window.desktop.storage.listDirectory(parent, cursor));
          if (!isCurrent()) return;

          for (const entry of page.entries) entries.set(entry.ref.locator, entry);
          cursor = page.nextCursor;
          if (cursor === undefined) break;
          if (seenCursors.has(cursor)) throw new StorageBrowserError('OutcomeUnknown');
          seenCursors.add(cursor);

          if (!previous && page.entries.length > 0) {
            setListing({ phase: 'loading', entries: withAdditions(new Map(entries)) });
          }
        } while (cursor !== undefined);

        const updated = withAdditions(entries);
        if (cacheable) cache.save(parent, updated);
        setListing({ phase: 'ready', entries: updated });
      } catch (failure) {
        if (!isCurrent()) return;
        const error = errorKey(failure);
        setListing({
          phase: 'error',
          entries: withAdditions(previous ?? entries),
          snapshot: previous ? withAdditions(previous) : undefined,
          error,
        });
        if (error === 'authRequired') onAuthRequired();
      } finally {
        if (currentRequest.current === request) currentRequest.current = null;
      }
    },
    [parent, cache, cacheable, version, onAuthRequired],
  );

  useLayoutEffect(() => {
    let mounted = true;
    // Defer IPC until React has settled the mount, including the development Strict Mode remount.
    queueMicrotask(() => {
      if (!mounted || cache.version(parent.connectionId) !== version) return;
      const cached = cacheable ? cache.get(parent) : undefined;
      if (cached) {
        setListing((current) =>
          current.phase === 'ready' && current.entries === cached
            ? current
            : { phase: 'ready', entries: cached },
        );
      } else {
        void load();
      }
    });
    return () => {
      mounted = false;
      currentRequest.current = null;
    };
  }, [parent, cache, cacheable, version, load]);

  const { phase, entries } = listing;
  const snapshot = listingSnapshot(listing);

  useLayoutEffect(
    () =>
      cache.subscribeAdditions(({ parent: changedParent, entry }) => {
        if (entryKey(changedParent) !== entryKey(parent)) return;
        currentRequest.current?.additions.set(entry.ref.locator, entry);
        setListing((current) => {
          const entries = addDirectoryEntry(current.entries, entry);
          if (current.phase === 'error' && current.snapshot) {
            return { ...current, entries, snapshot: addDirectoryEntry(current.snapshot, entry) };
          }
          return { ...current, entries };
        });
      }),
    [cache, parent],
  );

  useLayoutEffect(
    () =>
      cache.subscribeRemovals(({ parent: changedParent, ref }) => {
        if (entryKey(changedParent) !== entryKey(parent)) return;
        currentRequest.current?.additions.delete(ref.locator);
        if (currentRequest.current !== null || snapshot === undefined) {
          void load(removeDirectoryEntry(entries, ref.locator));
        } else {
          setListing((current) => ({
            phase: 'ready',
            entries: removeDirectoryEntry(current.entries, ref.locator),
          }));
        }
      }),
    [cache, parent, snapshot, entries, load],
  );

  useLayoutEffect(
    () =>
      cache.subscribeRenames((change) => {
        if (entryKey(change.parent) !== entryKey(parent)) return;
        const { previous, entry } = change;
        const additions = currentRequest.current?.additions;
        if (additions?.delete(previous.locator)) additions.set(entry.ref.locator, entry);
        if (currentRequest.current !== null || snapshot === undefined) {
          void load(replaceRenamedEntry(entries, previous.locator, entry));
        } else {
          setListing((current) => ({
            phase: 'ready',
            entries: replaceRenamedEntry(current.entries, previous.locator, entry),
          }));
        }
      }),
    [cache, parent, snapshot, entries, load],
  );

  return {
    phase,
    entries,
    snapshot,
    error: phase === 'error' ? listing.error : null,
    refresh: () => {
      if (phase === 'ready' || phase === 'error') void load(snapshot);
    },
  };
}
