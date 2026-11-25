import { ActionIcon, Button, Checkbox, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { StorageConnectionSummary } from '@shared/storage-browser';
import { errorKey, resultOf } from '../storage-client';
import { formatStorageLabel } from '../storage-labels';
import classes from './SpacePicker.module.css';

const spacesErrorNotification = 'storage-spaces-error';

interface PickerProps {
  connection: StorageConnectionSummary;
  onBusy: (busy: boolean) => void;
  onCancel: () => void;
  onChanged: () => void;
  onSaved: () => void;
}

export function SpacePicker({ connection, onBusy, onCancel, onChanged, onSaved }: PickerProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  function showError(failure: unknown) {
    notifications.show({
      id: spacesErrorNotification,
      color: 'red',
      message: t(`errors:${errorKey(failure)}`),
    });
  }
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
      onError: (failure) => {
        showError(failure);
        onChanged();
      },
    },
  );
  const [selected, setSelected] = useState(() => new Set(connection.spaces.map(({ id }) => id)));
  const [action, setAction] = useState<'refresh' | 'save' | null>(null);

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
    try {
      const refreshed = await resultOf(window.desktop.storage.listSpaces(connection.id, true));
      await mutate(refreshed, { revalidate: false });
      const refreshedIds = new Set(refreshed.map(({ space }) => space.id));
      setSelected((previous) => new Set([...previous].filter((id) => refreshedIds.has(id))));
    } catch (failure) {
      showError(failure);
    } finally {
      onChanged();
      setAction(null);
      onBusy(false);
    }
  }

  async function save() {
    setAction('save');
    onBusy(true);
    try {
      await resultOf(window.desktop.storage.saveSpaces(connection.id, [...selected]));
      await mutate(
        (previous = choices) =>
          previous.filter(({ space, available }) => available || selected.has(space.id)),
        { revalidate: false },
      );
      onSaved();
    } catch (failure) {
      showError(failure);
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
      {!loading && !error && choices.length === 0 && (
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
