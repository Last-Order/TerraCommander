import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { StorageConnectionSummary, StorageProvider } from '@shared/storage-browser';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import { formatStorageLabel } from '../storage-labels';
import { SpacePicker } from './SpacePicker';
import { StorageTypePicker, type StorageTypeOption } from './StorageTypePicker';

export type SetupIntent =
  | { kind: 'add' }
  | { kind: 'manage' | 'reauthorize'; connection: StorageConnectionSummary };

interface SetupProps {
  intent: SetupIntent;
  onClose: () => void;
  onChanged: () => void;
  onAuthorized: (id: string) => void;
}

export function StorageSetupModal({ intent, onClose, onChanged, onAuthorized }: SetupProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const [connection, setConnection] = useState(intent.kind === 'manage' ? intent.connection : null);
  const [selectedProvider, setSelectedProvider] = useState<StorageProvider | null>(
    intent.kind === 'reauthorize' ? intent.connection.provider : null,
  );
  const [authorizing, setAuthorizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StorageErrorKey | null>(null);
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
      setError(errorKey(failure));
    });
  }

  async function selectType(option: StorageTypeOption) {
    setError(null);
    if (option.authMode === 'none') {
      setBusy(true);
      try {
        const added = await resultOf(window.desktop.storage.addConnection(option.id));
        setConnection(added);
      } catch (failure) {
        setError(errorKey(failure));
      } finally {
        setBusy(false);
      }
      return;
    }
    setSelectedProvider(option.id);
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
      } else if (selectedProvider) {
        const added = await resultOf(window.desktop.storage.addConnection(selectedProvider));
        onAuthorized(added.id);
        if (cancelRequested.current) onClose();
        else setConnection(added);
      }
    } catch (failure) {
      if (cancelRequested.current) onClose();
      else setError(errorKey(failure));
    } finally {
      setAuthorizing(false);
    }
  }

  let title: string = t('add');
  if (connection) title = t('manageSpaces');
  else if (existing) title = t('reauthorizeGoogleDrive');
  else if (selectedProvider) title = t('addGoogleDrive');

  let content: ReactNode;
  let choosingType = false;
  if (connection) {
    content = (
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
    );
  } else if (selectedProvider) {
    content = (
      <Stack gap="md">
        {existing && (
          <Text size="sm">
            {t('reauthorizeConfirmation', { name: formatStorageLabel(existing.name, t) })}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {existing
            ? t('reauthorizeInBrowser', { name: formatStorageLabel(existing.name, t) })
            : t('authorizeHint')}
        </Text>
        {error && (
          <Alert color="red" role="alert">
            {t(`errors:${error}`)}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dismiss}>
            {authorizing ? t('cancelAuthorization') : t('common:cancel')}
          </Button>
          <Button loading={authorizing} onClick={() => void authorize()}>
            {existing ? t('reauthorize') : t('authorizeInBrowser')}
          </Button>
        </Group>
      </Stack>
    );
  } else {
    choosingType = true;
    content = (
      <Stack gap="md">
        {error && (
          <Alert color="red" role="alert">
            {t(`errors:${error}`)}
          </Alert>
        )}
        <StorageTypePicker disabled={busy} onSelect={(option) => void selectType(option)} />
      </Stack>
    );
  }

  return (
    <Modal
      opened
      onClose={dismiss}
      title={title}
      size={choosingType ? 'lg' : 'md'}
      closeButtonProps={{ 'aria-label': t('common:close') }}
      centered
      closeOnClickOutside={!busy && !authorizing}
      closeOnEscape={!busy}
    >
      {content}
    </Modal>
  );
}
