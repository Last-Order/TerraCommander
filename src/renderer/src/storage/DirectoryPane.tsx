import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Button, Group, Loader } from '@mantine/core';
import { ChevronRight, File, Folder, FolderOpen, Link2, RefreshCw } from 'lucide-react';
import type { Entry, EntryPage, EntryRef, Space } from '../../../shared/storage';
import { errorText, resultOf, StorageBrowserError } from './storage-client';
import classes from './StorageWorkspace.module.css';

interface Location {
  ref: EntryRef;
  name: string;
}

interface DirectoryProps {
  space: Space;
  version: number;
  onAuthRequired: () => void;
}

export function DirectoryPane({ space, version, onAuthRequired }: DirectoryProps) {
  const [trail, setTrail] = useState<Location[]>([{ ref: space.root, name: space.name }]);
  const [reload, setReload] = useState(0);
  const current = trail.at(-1) ?? { ref: space.root, name: space.name };

  return (
    <main className={classes.directory}>
      <header className={classes.directoryHeader}>
        <nav className={classes.breadcrumbs} aria-label="当前目录">
          {trail.map((location, index) => (
            <div className={classes.crumb} key={index}>
              {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
              {index === trail.length - 1 ? (
                <span aria-current="page" title={location.name}>
                  {location.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setTrail(trail.slice(0, index + 1))}
                  title={location.name}
                >
                  {location.name}
                </button>
              )}
            </div>
          ))}
        </nav>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="刷新目录"
          onClick={() => setReload(reload + 1)}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      <DirectoryListing
        key={JSON.stringify([current.ref.locator, version, reload])}
        parent={current.ref}
        onOpen={(entry) => setTrail([...trail, entry])}
        onAuthRequired={onAuthRequired}
        onReload={() => setReload(reload + 1)}
      />
    </main>
  );
}

export function EmptyDirectoryPane() {
  return (
    <main className={classes.emptyDirectory}>
      <FolderOpen size={32} strokeWidth={1.5} aria-hidden="true" />
      <h1>选择一个存储空间</h1>
      <p>从侧栏打开已添加的磁盘、文件夹或云端硬盘。</p>
    </main>
  );
}

interface ListingProps {
  parent: EntryRef;
  onOpen: (entry: Entry) => void;
  onAuthRequired: () => void;
  onReload: () => void;
}

function DirectoryListing({ parent, onOpen, onAuthRequired, onReload }: ListingProps) {
  const [page, setPage] = useState<EntryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ cursor?: string | undefined }>({});

  useEffect(() => {
    let current = true;
    void resultOf(window.desktop.storage.listDirectory(parent, request.cursor))
      .then((result) => {
        if (!current) return;
        setPage((previous) => {
          if (!previous || !request.cursor) return result;
          const entries = new Map(previous.entries.map((entry) => [entry.ref.locator, entry]));
          for (const entry of result.entries) entries.set(entry.ref.locator, entry);
          return { ...result, entries: [...entries.values()] };
        });
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setError(errorText(failure));
        if (failure instanceof StorageBrowserError && failure.code === 'AuthRequired')
          onAuthRequired();
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [parent, request, onAuthRequired]);

  return (
    <div className={classes.directoryContents} aria-busy={loading}>
      {loading && !page && <Loader size="sm" aria-label="正在加载目录" />}
      {error && (
        <Alert color="red" role="alert">
          <Group justify="space-between">
            {error}
            <Button variant="subtle" size="compact-sm" onClick={onReload}>
              重试
            </Button>
          </Group>
        </Alert>
      )}
      {page?.entries.length === 0 && !page.nextCursor && !error && (
        <p className={classes.directoryStatus}>此文件夹为空。</p>
      )}
      {page && page.entries.length > 0 && (
        <ul className={classes.entries} aria-label="文件和文件夹">
          {page.entries.map((entry) => (
            <li key={entry.ref.locator}>
              {entry.kind === 'directory' ? (
                <button type="button" className={classes.entry} onClick={() => onOpen(entry)}>
                  <Folder size={17} aria-hidden="true" />
                  <span>{entry.name}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ) : (
                <div className={classes.entry}>
                  {entry.kind === 'link' ? (
                    <Link2 size={17} aria-hidden="true" />
                  ) : (
                    <File size={17} aria-hidden="true" />
                  )}
                  <span>{entry.name}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {page?.nextCursor && !error && (
        <Button
          variant="default"
          size="compact-sm"
          loading={loading}
          onClick={() => {
            setLoading(true);
            setRequest({ cursor: page.nextCursor });
          }}
        >
          加载更多
        </Button>
      )}
    </div>
  );
}
