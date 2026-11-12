import { useRef, useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { Cloud, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  emptyLocalConnection,
  type StorageConnectionSummary,
} from '../../../../shared/storage-browser';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import { formatStorageLabel } from '../storage-labels';
import { SpacePicker } from './SpacePicker';

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

export function StorageSetupModal({
  intent,
  localConnection,
  onClose,
  onChanged,
  onAuthorized,
}: SetupProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const [connection, setConnection] = useState(intent.kind === 'manage' ? intent.connection : null);
  const [showAuthorization, setShowAuthorization] = useState(intent.kind === 'reauthorize');
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
      else setError(errorKey(failure));
    } finally {
      setAuthorizing(false);
    }
  }

  let title: string = t('add');
  if (connection) title = t('manageSpaces');
  else if (existing) title = t('reauthorizeGoogleDrive');
  else if (showAuthorization) title = t('addGoogleDrive');

  return (
    <Modal
      opened
      onClose={dismiss}
      title={title}
      closeButtonProps={{ 'aria-label': t('common:close') }}
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
      ) : (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            {t('chooseType')}
          </Text>
          <Button
            justify="flex-start"
            variant="default"
            leftSection={<Monitor size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => setConnection(localConnection ?? emptyLocalConnection)}
          >
            {t('localFileSystem')}
          </Button>
          <Button
            justify="flex-start"
            variant="default"
            leftSection={<Cloud size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => setShowAuthorization(true)}
          >
            Google Drive
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
