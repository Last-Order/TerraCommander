import { useState } from 'react';
import { ActionIcon, Alert, Button, Checkbox, Group, Loader, Stack, Text } from '@mantine/core';
import { FolderPlus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { StorageConnectionSummary } from '../../../../shared/storage-browser';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import { formatStorageLabel } from '../storage-labels';
import classes from './SpacePicker.module.css';

interface PickerProps {
  connection: StorageConnectionSummary;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
  onChanged: () => void;
  onSaved: () => void;
}

export function SpacePicker({ connection, onBusy, onCancel, onChanged, onSaved }: PickerProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const {
    data: choices,
    error,
    isLoading: loading,
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
  const [action, setAction] = useState<'folder' | 'refresh' | 'save' | null>(null);
  const [actionError, setActionError] = useState<StorageErrorKey | null>(null);
  const pickerError = actionError ?? (!loading && error ? errorKey(error) : null);

  function toggle(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function refreshSpaces() {
    setAction('refresh');
    onBusy(true);
    setActionError(null);
    try {
      const refreshed = await resultOf(window.desktop.storage.listSpaces(connection.id, true));
      await mutate(refreshed, { revalidate: false });
      const refreshedIds = new Set(refreshed.map(({ space }) => space.id));
      setSelected((previous) => new Set([...previous].filter((id) => refreshedIds.has(id))));
    } catch (failure) {
      setActionError(errorKey(failure));
    } finally {
      onChanged();
      setAction(null);
      onBusy(false);
    }
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
      setActionError(errorKey(failure));
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
        (previous = choices) =>
          previous.filter(({ space, available }) => available || selected.has(space.id)),
        { revalidate: false },
      );
      onSaved();
    } catch (failure) {
      setActionError(errorKey(failure));
    } finally {
      setAction(null);
      onBusy(false);
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between" gap="xs">
        <Text size="sm" c="dimmed">
          {formatStorageLabel(connection.detail ?? connection.name, t)}
        </Text>
        <ActionIcon
          variant="subtle"
          aria-label={t('refreshSpaces')}
          title={t('refreshSpaces')}
          loading={action === 'refresh'}
          disabled={loading || action !== null}
          onClick={() => void refreshSpaces()}
        >
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </Group>
      {loading && <Loader size="sm" aria-label={t('discoveringSpaces')} />}
      {pickerError && (
        <Alert color="red" role="alert">
          {t(`errors:${pickerError}`)}
        </Alert>
      )}
      {!loading && !pickerError && choices.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('noAvailableSpaces')}
        </Text>
      )}
      <div className={classes.spaceChoices}>
        {choices.map(({ space, available }) => (
          <Checkbox
            key={space.id}
            label={formatStorageLabel(space.name, t)}
            description={available ? undefined : t('spaceUnavailable')}
            checked={selected.has(space.id)}
            disabled={loading || action !== null}
            onChange={(event) => toggle(space.id, event.currentTarget.checked)}
          />
        ))}
      </div>
      {connection.provider === 'local' && (
        <Button
          variant="light"
          leftSection={<FolderPlus size={16} strokeWidth={1.5} aria-hidden="true" />}
          loading={action === 'folder'}
          disabled={loading || action !== null}
          onClick={() => void chooseFolder()}
        >
          {t('chooseFolder')}
        </Button>
      )}
      <Group justify="flex-end">
        <Button variant="default" disabled={action !== null} onClick={onCancel}>
          {t('common:cancel')}
        </Button>
        <Button
          loading={action === 'save'}
          disabled={loading || action !== null}
          onClick={() => void save()}
        >
          {t('common:save')}
        </Button>
      </Group>
    </Stack>
  );
}
