import { Button, Stack, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadDirectoryInput } from '../downloads/DownloadDirectoryInput';
import { errorKey, resultOf, type StorageErrorKey } from '../storage/storage-client';

export function DownloadSettingsSection() {
  const { t } = useTranslation(['settings', 'common', 'errors']);
  const [loaded, setLoaded] = useState(false);
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState<StorageErrorKey>();
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const draft = useRef<string | undefined>(undefined);
  const dirty = useRef(false);
  const revision = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requests = useRef(new Set<number>());

  const persist = useCallback((value: string, version: number) => {
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
          setDirectory(saved);
          setError(undefined);
        }
      } catch (error) {
        if (active.current && version === revision.current) setError(errorKey(error));
      } finally {
        requests.current.delete(version);
      }
    })();
  }, []);

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
          setDirectory(value);
          draft.current = value;
        }
      } catch (error) {
        if (current) setError(errorKey(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt]);
  function changeDirectory(value: string, immediate = false) {
    if (draft.current === value) {
      if (immediate) flush();
      return;
    }
    draft.current = value;
    dirty.current = true;
    revision.current++;
    setDirectory(value);
    setError(undefined);
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
      {error && (
        <Text size="sm" c="red" role="alert">
          {t(`errors:${error}`)}
        </Text>
      )}
      {error && !loaded && (
        <Button
          variant="subtle"
          onClick={() => {
            setError(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          {t('common:retry')}
        </Button>
      )}
    </Stack>
  );
}
