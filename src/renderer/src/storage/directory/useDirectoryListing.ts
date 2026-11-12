import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { errorKey, resultOf, StorageBrowserError, type StorageErrorKey } from '../storage-client';
import {
  directoryKey,
  replaceRenamedEntry,
  type DirectoryCache,
  type DirectoryEntries,
} from './directory-cache';

type ListingState =
  | { phase: 'loading' | 'ready' | 'refreshing'; entries: DirectoryEntries }
  | {
      phase: 'error';
      entries: DirectoryEntries;
      snapshot: DirectoryEntries | undefined;
      error: StorageErrorKey;
    };

interface ListingOptions {
  parent: EntryRef;
  cache: DirectoryCache;
  cacheable: boolean;
  version: number;
  onAuthRequired: () => void;
  onEntryRenamed: (previous: string, locator: string) => void;
}

const emptyEntries: DirectoryEntries = new Map();

export function useDirectoryListing({
  parent,
  cache,
  cacheable,
  version,
  onAuthRequired,
  onEntryRenamed,
}: ListingOptions) {
  const [listing, setListing] = useState<ListingState>(() => {
    const cached = cacheable ? cache.peek(parent) : undefined;
    return cached
      ? { phase: 'ready', entries: cached }
      : { phase: 'loading', entries: emptyEntries };
  });
  const currentRequest = useRef<symbol | null>(null);

  const load = useCallback(
    async (previous?: DirectoryEntries) => {
      if (cache.version(parent.connectionId) !== version) return;
      const request = Symbol();
      currentRequest.current = request;
      const isCurrent = () =>
        currentRequest.current === request && cache.version(parent.connectionId) === version;

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
            setListing({ phase: 'loading', entries: new Map(entries) });
          }
        } while (cursor !== undefined);

        if (cacheable) cache.save(parent, entries);
        setListing({ phase: 'ready', entries });
      } catch (failure) {
        if (!isCurrent()) return;
        const error = errorKey(failure);
        setListing({ phase: 'error', entries: previous ?? entries, snapshot: previous, error });
        if (error === 'AuthRequired') onAuthRequired();
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
  const snapshot = phase === 'error' ? listing.snapshot : phase === 'loading' ? undefined : entries;

  useLayoutEffect(
    () =>
      cache.subscribeRenames((change) => {
        if (directoryKey(change.parent) !== directoryKey(parent)) return;
        const { previous, entry } = change;
        if (currentRequest.current !== null || snapshot === undefined) {
          void load(replaceRenamedEntry(entries, previous.locator, entry));
        } else {
          setListing((current) => ({
            phase: 'ready',
            entries: replaceRenamedEntry(current.entries, previous.locator, entry),
          }));
        }
        onEntryRenamed(previous.locator, entry.ref.locator);
      }),
    [cache, parent, snapshot, entries, load, onEntryRenamed],
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
