import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { Cloud, FolderPlus, Monitor } from 'lucide-react';
import useSWR from 'swr';
import { localConnectionId, type StorageConnectionSummary } from '../../../shared/storage-browser';
import { errorText, resultOf } from './storage-client';
import classes from './StorageWorkspace.module.css';

export type SetupIntent =
  | { kind: 'add' }
  | { kind: 'manage' | 'reauthorize'; connection: StorageConnectionSummary };

interface SetupProps {
  intent: SetupIntent;
  localConnection: StorageConnectionSummary | undefined;
  onClose: () => void;
  onChanged: () => void;
  onAuthorized: (id: string) => void;
}

const localDraft: StorageConnectionSummary = {
  id: localConnectionId,
  provider: 'local',
  name: '此电脑',
  needsAuthorization: false,
  spaces: [],
};

export function StorageSetupModal({
  intent,
  localConnection,
  onClose,
  onChanged,
  onAuthorized,
}: SetupProps) {
  const [connection, setConnection] = useState(intent.kind === 'manage' ? intent.connection : null);
  const [showAuthorization, setShowAuthorization] = useState(intent.kind === 'reauthorize');
  const [authorizing, setAuthorizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRequested = useRef(false);
  const existing = intent.kind === 'reauthorize' ? intent.connection : null;

  function dismiss() {
    if (busy) return;
    if (!authorizing) {
      onClose();
      return;
    }
    cancelRequested.current = true;
    void resultOf(window.desktop.storage.cancelAuthorization()).catch((failure: unknown) => {
      cancelRequested.current = false;
      setError(errorText(failure));
    });
  }

  async function authorize() {
    cancelRequested.current = false;
    setAuthorizing(true);
    setError(null);
    try {
      if (existing) {
        await resultOf(window.desktop.storage.reauthorize(existing.id));
        onAuthorized(existing.id);
        onClose();
      } else {
        const added = await resultOf(window.desktop.storage.addGoogleDrive());
        onAuthorized(added.id);
        if (cancelRequested.current) onClose();
        else setConnection(added);
      }
    } catch (failure) {
      if (cancelRequested.current) onClose();
      else setError(errorText(failure));
    } finally {
      setAuthorizing(false);
    }
  }

  let title = '添加存储';
  if (connection) title = '管理显示的空间';
  else if (existing) title = '重新授权 Google Drive';
  else if (showAuthorization) title = '添加 Google Drive';

  return (
    <Modal
      opened
      onClose={dismiss}
      title={title}
      centered
      closeOnClickOutside={!busy && !authorizing}
      closeOnEscape={!busy}
    >
      {connection ? (
        <SpacePicker
          connection={connection}
          onBusy={setBusy}
          onCancel={dismiss}
          onChanged={onChanged}
          onSaved={() => {
            onChanged();
            onClose();
          }}
        />
      ) : showAuthorization ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {existing
              ? `请在浏览器中使用 ${existing.name} 对应的 Google 账号完成授权。`
              : '在浏览器中完成授权后，选择要显示的云端硬盘。'}
          </Text>
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={dismiss}>
              {authorizing ? '取消授权' : '取消'}
            </Button>
            <Button loading={authorizing} onClick={() => void authorize()}>
              在浏览器中授权
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            选择存储类型
          </Text>
          <Button
            justify="flex-start"
            variant="default"
            leftSection={<Monitor size={18} />}
            onClick={() => setConnection(localConnection ?? localDraft)}
          >
            本地文件系统
          </Button>
          <Button
            justify="flex-start"
            variant="default"
            leftSection={<Cloud size={18} />}
            onClick={() => setShowAuthorization(true)}
          >
            Google Drive
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

interface PickerProps {
  connection: StorageConnectionSummary;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
  onChanged: () => void;
  onSaved: () => void;
}

function SpacePicker({ connection, onBusy, onCancel, onChanged, onSaved }: PickerProps) {
  const {
    data: choices,
    error,
    isValidating: loading,
    mutate,
  } = useSWR(
    ['storage/spaces', connection.id] as const,
    ([, id]) => resultOf(window.desktop.storage.listSpaces(id)),
    {
      fallbackData: connection.spaces.map((space) => ({ space, available: true })),
      onError: onChanged,
    },
  );
  const [selected, setSelected] = useState(() => new Set(connection.spaces.map(({ id }) => id)));
  const [action, setAction] = useState<'folder' | 'save' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const discoveryError = !loading && error ? errorText(error) : null;

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function chooseFolder() {
    setAction('folder');
    onBusy(true);
    setActionError(null);
    try {
      const space = await resultOf(window.desktop.storage.chooseFolder());
      if (space) {
        await mutate(
          (previous = choices) => [
            ...previous.filter((choice) => choice.space.id !== space.id),
            { space, available: true },
          ],
          { revalidate: false },
        );
        toggle(space.id, true);
      }
    } catch (failure) {
      setActionError(errorText(failure));
    } finally {
      setAction(null);
      onBusy(false);
    }
  }

  async function save() {
    setAction('save');
    onBusy(true);
    setActionError(null);
    try {
      await resultOf(window.desktop.storage.saveSpaces(connection.id, [...selected]));
      await mutate(
        choices.filter(({ space, available }) => available || selected.has(space.id)),
        { revalidate: false },
      );
      onSaved();
    } catch (failure) {
      setActionError(errorText(failure));
    } finally {
      setAction(null);
      onBusy(false);
    }
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {connection.detail ?? connection.name}
      </Text>
      {loading && <Loader size="sm" aria-label="正在查找空间" />}
      {discoveryError && (
        <Alert color="red" role="alert">
          <Group justify="space-between">
            {discoveryError}
            <Button
              size="compact-sm"
              variant="subtle"
              onClick={() => void mutate()}
              disabled={action !== null}
            >
              重试
            </Button>
          </Group>
        </Alert>
      )}
      {!loading && !discoveryError && choices.length === 0 && (
        <Text size="sm" c="dimmed">
          未找到可用空间。
        </Text>
      )}
      <div className={classes.spaceChoices}>
        {choices.map(({ space, available }) => (
          <Checkbox
            key={space.id}
            label={space.name}
            description={available ? undefined : '当前不可用'}
            checked={selected.has(space.id)}
            disabled={loading || action !== null}
            onChange={(event) => toggle(space.id, event.currentTarget.checked)}
          />
        ))}
      </div>
      {connection.provider === 'local' && (
        <Button
          variant="light"
          leftSection={<FolderPlus size={16} />}
          loading={action === 'folder'}
          disabled={loading || action === 'save'}
          onClick={() => void chooseFolder()}
        >
          选择文件夹
        </Button>
      )}
      {actionError && (
        <Alert color="red" role="alert">
          {actionError}
        </Alert>
      )}
      <Group justify="flex-end">
        <Button variant="default" disabled={action !== null} onClick={onCancel}>
          取消
        </Button>
        <Button
          loading={action === 'save'}
          disabled={loading || action === 'folder'}
          onClick={() => void save()}
        >
          保存
        </Button>
      </Group>
    </Stack>
  );
}
