import { useId, useState } from 'react';
import { ActionIcon, Button, Loader } from '@mantine/core';
import {
  ChevronDown,
  Cloud,
  HardDrive,
  Layers,
  Monitor,
  Plus,
  Settings,
  SlidersHorizontal,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Space } from '../../../shared/storage';
import type { StorageConnectionSummary } from '../../../shared/storage-browser';
import { formatStorageLabel } from './storage-labels';
import classes from './StorageWorkspace.module.css';

interface SidebarProps {
  connections: StorageConnectionSummary[];
  activeSpace: Space | null;
  loading: boolean;
  error: string | null;
  onOpenSettings: () => void;
  onRetry: () => void;
  onAdd: () => void;
  onManage: (connection: StorageConnectionSummary) => void;
  onReauthorize: (connection: StorageConnectionSummary) => void;
  onOpen: (space: Space) => void;
}

export function StorageSidebar({
  connections,
  activeSpace,
  loading,
  error,
  onOpenSettings,
  onRetry,
  onAdd,
  onManage,
  onReauthorize,
  onOpen,
}: SidebarProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'settings']);
  const { compare } = new Intl.Collator(i18n.resolvedLanguage);
  const sorted = connections.toSorted((a, b) =>
    compare(formatStorageLabel(a.name, t), formatStorageLabel(b.name, t)),
  );

  return (
    <aside className={classes.sidebar}>
      <header className={classes.brand}>
        <Layers size={19} aria-hidden="true" /> TerraCommander
      </header>
      <nav className={classes.navigation} aria-label={t('title')}>
        <div className={classes.sidebarHeading}>
          <h2>{t('title')}</h2>
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<Plus size={15} />}
            onClick={onAdd}
          >
            {t('add')}
          </Button>
        </div>
        {loading && <Loader size="sm" aria-label={t('loading')} />}
        {error && (
          <div className={classes.sidebarStatus} role="alert">
            <p>{error}</p>
            <Button size="compact-sm" variant="subtle" onClick={onRetry}>
              {t('common:retry')}
            </Button>
          </div>
        )}
        {!loading && !error && connections.length === 0 && (
          <p className={classes.sidebarStatus}>{t('addPrompt')}</p>
        )}
        {sorted.map((connection) => (
          <ConnectionGroup
            key={connection.id}
            connection={connection}
            activeSpace={activeSpace}
            onManage={onManage}
            onReauthorize={onReauthorize}
            onOpen={onOpen}
          />
        ))}
      </nav>
      <footer className={classes.sidebarFooter}>
        <Button
          fullWidth
          justify="flex-start"
          variant="subtle"
          color="gray"
          leftSection={<Settings size={17} aria-hidden="true" />}
          aria-haspopup="dialog"
          onClick={onOpenSettings}
        >
          {t('settings:title')}
        </Button>
      </footer>
    </aside>
  );
}

interface GroupProps {
  connection: StorageConnectionSummary;
  activeSpace: Space | null;
  onManage: SidebarProps['onManage'];
  onReauthorize: SidebarProps['onReauthorize'];
  onOpen: SidebarProps['onOpen'];
}

function ConnectionGroup({ connection, activeSpace, onManage, onReauthorize, onOpen }: GroupProps) {
  const { t } = useTranslation('storage');
  const [expanded, setExpanded] = useState(true);
  const spaceListId = useId();
  const Icon = connection.provider === 'local' ? Monitor : Cloud;
  const name = formatStorageLabel(connection.name, t);
  const detail = connection.detail && formatStorageLabel(connection.detail, t);

  return (
    <section className={classes.connection} aria-label={name}>
      <div className={classes.connectionHeading}>
        <button
          type="button"
          className={classes.connectionToggle}
          aria-expanded={expanded}
          aria-controls={spaceListId}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={14} aria-hidden="true" className={classes.chevron} />
          <Icon size={17} aria-hidden="true" />
          <span className={classes.connectionText}>
            <strong title={name}>{name}</strong>
            {detail && <small title={detail}>{detail}</small>}
          </span>
        </button>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('manageConnectionSpaces', { name })}
          title={t('manageSpaces')}
          onClick={() => onManage(connection)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
        </ActionIcon>
      </div>
      {connection.needsAuthorization && (
        <Button
          size="compact-xs"
          variant="subtle"
          className={classes.authorization}
          onClick={() => onReauthorize(connection)}
        >
          {t('reauthorize')}
        </Button>
      )}
      <ul className={classes.spaces} id={spaceListId} hidden={!expanded}>
        {connection.spaces.length === 0 && (
          <li className={classes.sidebarStatus}>{t('noDisplayedSpaces')}</li>
        )}
        {connection.spaces.map((space) => {
          const label = formatStorageLabel(space.name, t);
          return (
            <li key={space.id}>
              <button
                type="button"
                className={classes.space}
                title={label}
                aria-current={
                  activeSpace?.connectionId === connection.id && activeSpace.id === space.id
                    ? 'location'
                    : undefined
                }
                onClick={() => onOpen(space)}
              >
                <HardDrive size={16} aria-hidden="true" />
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
