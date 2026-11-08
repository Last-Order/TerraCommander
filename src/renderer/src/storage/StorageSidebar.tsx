import { useId, useState } from 'react';
import { ActionIcon, Button, Loader } from '@mantine/core';
import {
  ChevronDown,
  Cloud,
  HardDrive,
  Layers,
  Monitor,
  Plus,
  SlidersHorizontal,
} from 'lucide-react';
import type { Space } from '../../../shared/storage';
import type { StorageConnectionSummary } from '../../../shared/storage-browser';
import classes from './StorageWorkspace.module.css';

interface SidebarProps {
  connections: StorageConnectionSummary[];
  activeSpace: Space | null;
  loading: boolean;
  error: string | null;
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
  onRetry,
  onAdd,
  onManage,
  onReauthorize,
  onOpen,
}: SidebarProps) {
  return (
    <aside className={classes.sidebar}>
      <header className={classes.brand}>
        <Layers size={19} aria-hidden="true" /> TerraCommander
      </header>
      <nav className={classes.navigation} aria-label="存储">
        <div className={classes.sidebarHeading}>
          <h2>存储</h2>
          <Button
            size="compact-sm"
            variant="light"
            leftSection={<Plus size={15} />}
            onClick={onAdd}
          >
            添加存储
          </Button>
        </div>
        {loading && <Loader size="sm" aria-label="正在加载存储" />}
        {error && (
          <div className={classes.sidebarStatus} role="alert">
            <p>{error}</p>
            <Button size="compact-sm" variant="subtle" onClick={onRetry}>
              重试
            </Button>
          </div>
        )}
        {!loading && !error && connections.length === 0 && (
          <p className={classes.sidebarStatus}>
            添加本地文件系统或 Google Drive，选择要显示的空间。
          </p>
        )}
        {connections.map((connection) => (
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
  const [expanded, setExpanded] = useState(true);
  const spaceListId = useId();
  const Icon = connection.provider === 'local' ? Monitor : Cloud;

  return (
    <section className={classes.connection} aria-label={connection.name}>
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
            <strong title={connection.name}>{connection.name}</strong>
            {connection.detail && <small title={connection.detail}>{connection.detail}</small>}
          </span>
        </button>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`管理 ${connection.name} 显示的空间`}
          title="管理显示的空间"
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
          重新授权
        </Button>
      )}
      <ul className={classes.spaces} id={spaceListId} hidden={!expanded}>
        {connection.spaces.length === 0 && (
          <li className={classes.sidebarStatus}>暂无显示的空间</li>
        )}
        {connection.spaces.map((space) => (
          <li key={space.id}>
            <button
              type="button"
              className={classes.space}
              title={space.name}
              aria-current={
                activeSpace?.connectionId === connection.id && activeSpace.id === space.id
                  ? 'location'
                  : undefined
              }
              onClick={() => onOpen(space)}
            >
              <HardDrive size={16} aria-hidden="true" />
              <span>{space.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
