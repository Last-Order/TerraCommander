import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ChevronRight, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EntryRef, Space, StorageLabel } from '../../../../shared/storage';
import { formatStorageLabel } from '../storage-labels';
import classes from './DirectoryPane.module.css';
import { DirectoryListing } from './DirectoryListing';
import { directoryKey, type DirectoryCache } from './directory-cache';

interface Location {
  ref: EntryRef;
  name: StorageLabel;
}

interface DirectoryProps {
  space: Space;
  cache: DirectoryCache;
  onAuthRequired: () => void;
}

export function DirectoryPane({ space, cache, onAuthRequired }: DirectoryProps) {
  const { t } = useTranslation('storage');
  const [trail, setTrail] = useState<Location[]>([{ ref: space.root, name: space.name }]);
  const current = trail.at(-1) ?? { ref: space.root, name: space.name };
  const version = useSyncExternalStore(cache.subscribe, () => cache.version(space.connectionId));

  useLayoutEffect(
    () =>
      cache.subscribeRenames(({ previous, entry }) => {
        if (entry.kind !== 'directory') return;
        setTrail((locations) => {
          const index = locations.findIndex(
            ({ ref }) => directoryKey(ref) === directoryKey(previous),
          );
          if (index < 0) return locations;
          const updated = [...locations];
          updated[index] = { ref: entry.ref, name: entry.name };
          return previous.locator === entry.ref.locator ? updated : updated.slice(0, index + 1);
        });
      }),
    [cache],
  );

  return (
    <main className={classes.directory}>
      <DirectoryListing
        key={`${directoryKey(current.ref)}:${version}`}
        parent={current.ref}
        cache={cache}
        cacheable={trail.length === 1}
        version={version}
        directoryPath={trail.map(({ name }) => formatStorageLabel(name, t)).join(' / ')}
        onOpen={(entry) => setTrail([...trail, entry])}
        onAuthRequired={onAuthRequired}
      >
        <nav className={classes.breadcrumbs} aria-label={t('currentDirectory')}>
          {trail.map((location, index) => {
            const name = formatStorageLabel(location.name, t);
            return (
              <div className={classes.crumb} key={index}>
                {index > 0 && <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
                {index === trail.length - 1 ? (
                  <span aria-current="page" title={name}>
                    {name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTrail(trail.slice(0, index + 1))}
                    title={name}
                  >
                    {name}
                  </button>
                )}
              </div>
            );
          })}
        </nav>
      </DirectoryListing>
    </main>
  );
}

export function EmptyDirectoryPane() {
  const { t } = useTranslation('storage');
  return (
    <main className={classes.emptyDirectory}>
      <FolderOpen size={32} strokeWidth={1.5} aria-hidden="true" />
      <h1>{t('chooseSpace')}</h1>
      <p>{t('chooseSpaceHint')}</p>
    </main>
  );
}
