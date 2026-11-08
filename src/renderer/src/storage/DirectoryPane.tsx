import { useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Group, Loader } from '@mantine/core';
import { ChevronRight, File, Folder, FolderOpen, Link2, RefreshCw } from 'lucide-react';
import useSWRInfinite from 'swr/infinite';
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
  const current = trail.at(-1) ?? { ref: space.root, name: space.name };

  return (
    <main className={classes.directory}>
      <DirectoryListing
        key={JSON.stringify([current.ref, version])}
        parent={current.ref}
        version={version}
        onOpen={(entry) => setTrail([...trail, entry])}
        onAuthRequired={onAuthRequired}
      >
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
      </DirectoryListing>
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
  version: number;
  onOpen: (entry: Entry) => void;
  onAuthRequired: () => void;
  children: ReactNode;
}

function DirectoryListing({ parent, version, onOpen, onAuthRequired, children }: ListingProps) {
  const {
    data: pages,
    error: failure,
    isValidating: loading,
    mutate,
    setSize,
  } = useSWRInfinite(
    (index, previous: EntryPage | null) => {
      if (index > 0 && !previous?.nextCursor) return null;
      return ['storage/directory', parent, version, previous?.nextCursor] as const;
    },
    ([, ref, , cursor]) => resultOf(window.desktop.storage.listDirectory(ref, cursor)),
    {
      revalidateOnMount: true,
      revalidateFirstPage: false,
      onError(error: unknown) {
        if (error instanceof StorageBrowserError && error.code === 'AuthRequired') onAuthRequired();
      },
    },
  );
  const entries = new Map<string, Entry>();
  for (const page of pages ?? []) {
    for (const entry of page.entries) entries.set(entry.ref.locator, entry);
  }
  const nextCursor = pages?.at(-1)?.nextCursor;
  const error = !loading && failure ? errorText(failure) : null;
  const reload = () => void mutate();

  return (
    <>
      <header className={classes.directoryHeader}>
        {children}
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="刷新目录"
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      <div className={classes.directoryContents} aria-busy={loading}>
        {loading && !pages && <Loader size="sm" aria-label="正在加载目录" />}
        {error && (
          <Alert color="red" role="alert">
            <Group justify="space-between">
              {error}
              <Button variant="subtle" size="compact-sm" onClick={reload}>
                重试
              </Button>
            </Group>
          </Alert>
        )}
        {pages && entries.size === 0 && !nextCursor && !error && (
          <p className={classes.directoryStatus}>此文件夹为空。</p>
        )}
        {entries.size > 0 && (
          <ul className={classes.entries} aria-label="文件和文件夹">
            {[...entries.values()].map((entry) => (
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
        {nextCursor && !error && (
          <Button
            variant="default"
            size="compact-sm"
            loading={loading}
            onClick={() => void setSize((size) => size + 1)}
          >
            加载更多
          </Button>
        )}
      </div>
    </>
  );
}
