import { Button, getDefaultZIndex, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import classes from './DownloadOverwriteModal.module.css';

export function DownloadOverwriteModal({
  busy,
  conflicts,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  conflicts?: readonly string[] | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['storage', 'common']);
  return (
    <Modal
      opened
      centered
      size="sm"
      zIndex={getDefaultZIndex('modal') + 1}
      title={t('confirmDownloadOverwrite')}
      onClose={() => {
        if (!busy) onCancel();
      }}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      closeButtonProps={{ disabled: busy, 'aria-label': t('common:close') }}
    >
      <Stack>
        <Text>{t(conflicts ? 'downloadItemsExist' : 'downloadFileExists')}</Text>
        {conflicts && (
          <Text size="sm" className={classes.conflicts}>
            {conflicts.join('、')}
          </Text>
        )}
        <Group justify="flex-end">
          <Button data-autofocus variant="default" disabled={busy} onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button color="red" loading={busy} onClick={onConfirm}>
            {t('overwriteAndDownload')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
