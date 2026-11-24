import { ChevronRight, FolderOpen } from 'lucide-react';
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  entryKey,
  type Capabilities,
  type EntryRef,
  type Space,
  type StorageLabel,
} from '@shared/storage';
import { formatStorageLabel } from '../storage-labels';
import { useStorageWorkspace } from '../storage-workspace-context';
import {
  createCurrentDirectoryValue,
  CurrentDirectoryContext,
  type CurrentDirectoryContextValue,
} from './current-directory-context';
import { DirectoryListing } from './DirectoryListing';
import classes from './DirectoryPane.module.css';

interface Location {
  ref: EntryRef;
  name: StorageLabel;
  capabilities?: Capabilities;
}

interface DirectoryProps {
  space: Space;
}

export function DirectoryPane({ space }: DirectoryProps) {
  const { t } = useTranslation('storage');
  const { directoryCache: cache } = useStorageWorkspace();
  const [trail, setTrail] = useState<Location[]>([{ ref: space.root, name: space.name }]);
  const current = trail.at(-1) ?? { ref: space.root, name: space.name };
  const version = useSyncExternalStore(cache.subscribe, () => cache.version(space.connectionId));

  useLayoutEffect(
    () =>
      cache.subscribeRenames(({ previous, entry }) => {
        if (entry.kind !== 'directory') return;
        setTrail((locations) => {
          const index = locations.findIndex(({ ref }) => entryKey(ref) === entryKey(previous));
          if (index < 0) return locations;
          const updated = [...locations];
          updated[index] = entry;
          return previous.locator === entry.ref.locator ? updated : updated.slice(0, index + 1);
        });
      }),
    [cache],
  );

  const currentDirectory = useMemo<CurrentDirectoryContextValue>(
    () =>
      createCurrentDirectoryValue({
        ref: current.ref,
        path: trail.map(({ name }) => formatStorageLabel(name, t)).join(' / '),
        capabilities: current.capabilities,
        ancestors: trail.map(({ ref }) => ref),
      }),
    [current.ref, current.capabilities, trail, t],
  );

  const navigateUp =
    trail.length > 1 ? () => setTrail((locations) => locations.slice(0, -1)) : undefined;

  return (
    <main className={classes.directory}>
      <CurrentDirectoryContext.Provider value={currentDirectory}>
        <DirectoryListing
          key={`${entryKey(current.ref)}:${version}`}
          cacheable={trail.length === 1}
          version={version}
          onOpen={(entry) => setTrail([...trail, entry])}
          onNavigateUp={navigateUp}
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
      </CurrentDirectoryContext.Provider>
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
