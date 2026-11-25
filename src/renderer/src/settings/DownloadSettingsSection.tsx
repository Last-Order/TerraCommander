import { Button, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadDirectoryInput } from '../downloads/DownloadDirectoryInput';
import { errorKey, resultOf } from '../storage/storage-client';

const downloadDirectoryErrorNotification = 'settings-download-directory-error';

export function DownloadSettingsSection() {
  const { t } = useTranslation(['settings', 'common', 'errors']);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [directory, setDirectory] = useState('');
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const draft = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const revision = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requests = useRef(new Set<number>());

  const persist = useCallback(
    (value: string, version: number) => {
      if (!dirty.current || requests.current.has(version)) return;
      requests.current.add(version);
      void (async () => {
        try {
          const saved = await resultOf(window.desktop.settings.set('downloads.directory', value));
          if (version !== revision.current) return;
          draft.current = saved;
          dirty.current = false;
          if (active.current) {
            setLoaded(true);
            setLoadFailed(false);
            setDirectory(saved);
          }
        } catch (failure) {
          if (active.current && version === revision.current) {
            notifications.show({
              id: downloadDirectoryErrorNotification,
              color: 'red',
              message: t(`errors:${errorKey(failure)}`),
            });
          }
        } finally {
          requests.current.delete(version);
        }
      })();
    },
    [t],
  );

  const flush = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = undefined;
    if (draft.current !== undefined) persist(draft.current, revision.current);
  }, [persist]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      flush();
    };
  }, [flush]);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const value = await resultOf(window.desktop.settings.get('downloads.directory'));
        if (current) {
          setLoaded(true);
          setLoadFailed(false);
          setDirectory(value);
          draft.current = value;
        }
      } catch (failure) {
        if (current) {
          setLoadFailed(true);
          notifications.show({
            id: downloadDirectoryErrorNotification,
            color: 'red',
            message: t(`errors:${errorKey(failure)}`),
          });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, t]);
  function changeDirectory(value: string, immediate = false) {
    if (draft.current === value) {
      if (immediate) flush();
      return;
    }
    draft.current = value;
    dirty.current = true;
    revision.current++;
    setDirectory(value);
    clearTimeout(pending.current);
    if (immediate) flush();
    else pending.current = setTimeout(flush, 300);
  }
  return (
    <Stack gap="xs">
      <DownloadDirectoryInput
        label={t('downloadDirectory')}
        value={directory}
        disabled={!loaded}
        onChange={(value) => changeDirectory(value)}
        onDirectorySelected={(value) => changeDirectory(value, true)}
        onBlur={flush}
      />
      <Text size="sm" c="dimmed">
        {t('downloadDirectoryHint')}
      </Text>
      {loadFailed && !loaded && (
        <Button
          variant="subtle"
          onClick={() => {
            setLoadFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t('common:retry')}
        </Button>
      )}
    </Stack>
  );
}
