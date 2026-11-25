import { Button, NumberInput, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { maxTransferConcurrency, minTransferConcurrency } from '@shared/tasks';
import { errorKey, resultOf } from '../storage/storage-client';
import classes from './SettingsDialog.module.css';

const transferConcurrencyErrorNotification = 'settings-transfer-concurrency-error';

function isValidConcurrency(value: string | number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minTransferConcurrency &&
    value <= maxTransferConcurrency
  );
}

function clampConcurrency(value: number): number {
  return Math.min(maxTransferConcurrency, Math.max(minTransferConcurrency, Math.trunc(value)));
}

export function TransferConcurrencySection() {
  const { t } = useTranslation(['settings', 'common', 'errors']);
  const [savedLimit, setSavedLimit] = useState<number>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [value, setValue] = useState<string | number>('');
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const draft = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const revision = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requests = useRef(new Set<number>());

  const persist = useCallback(
    (limit: number, version: number) => {
      if (!dirty.current || requests.current.has(version)) return;
      requests.current.add(version);
      void (async () => {
        try {
          const saved = await resultOf(
            window.desktop.settings.set('transfers.concurrencyLimit', limit),
          );
          if (version !== revision.current) return;
          draft.current = saved;
          dirty.current = false;
          if (active.current) {
            setSavedLimit(saved);
            setLoadFailed(false);
            setValue(saved);
          }
        } catch (err) {
          if (active.current && version === revision.current) {
            notifications.show({
              id: transferConcurrencyErrorNotification,
              color: 'red',
              message: t(`errors:${errorKey(err)}`),
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
        const loaded = await resultOf(window.desktop.settings.get('transfers.concurrencyLimit'));
        if (current) {
          setSavedLimit(loaded);
          setLoadFailed(false);
          setValue(loaded);
          draft.current = loaded;
        }
      } catch (err) {
        if (current) {
          setLoadFailed(true);
          notifications.show({
            id: transferConcurrencyErrorNotification,
            color: 'red',
            message: t(`errors:${errorKey(err)}`),
          });
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [attempt, t]);

  function scheduleSave(next: number) {
    if (draft.current === next && !dirty.current) return;
    draft.current = next;
    dirty.current = true;
    revision.current++;
    clearTimeout(pending.current);
    pending.current = setTimeout(flush, 300);
  }

  function handleChange(next: string | number) {
    setValue(next);
    if (isValidConcurrency(next)) {
      scheduleSave(next);
    } else {
      clearTimeout(pending.current);
      pending.current = undefined;
    }
  }

  function handleBlur() {
    if (savedLimit === undefined) return;
    if (isValidConcurrency(value)) {
      flush();
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const clamped = clampConcurrency(value);
      setValue(clamped);
      scheduleSave(clamped);
      flush();
      return;
    }
    clearTimeout(pending.current);
    pending.current = undefined;
    draft.current = savedLimit;
    dirty.current = false;
    setValue(savedLimit);
  }

  return (
    <Stack gap="xs">
      <NumberInput
        classNames={{ root: classes.setting }}
        label={t('transferConcurrency')}
        value={value}
        min={minTransferConcurrency}
        max={maxTransferConcurrency}
        step={1}
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="blur"
        disabled={savedLimit === undefined}
        onChange={handleChange}
        onBlur={handleBlur}
      />
      <Text size="sm" c="dimmed">
        {t('transferConcurrencyHint', {
          min: minTransferConcurrency,
          max: maxTransferConcurrency,
        })}
      </Text>
      {loadFailed && savedLimit === undefined && (
        <Button
          variant="subtle"
          onClick={() => {
            setLoadFailed(false);
            setAttempt((current) => current + 1);
          }}
        >
          {t('common:retry')}
        </Button>
      )}
    </Stack>
  );
}
