import { Button, getDefaultZIndex, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export function DownloadOverwriteModal({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
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
        <Text>{t('downloadFileExists')}</Text>
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
