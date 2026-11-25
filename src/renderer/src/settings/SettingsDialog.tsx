import {
  Modal,
  NativeSelect,
  Stack,
  Tabs,
  isMantineColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowDownUp, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { languagePreferences, type LanguagePreference } from '@shared/language';
import { resultOf } from '../storage/storage-client';
import { DownloadSettingsSection } from './DownloadSettingsSection';
import { TransferConcurrencySection } from './TransferConcurrencySection';
import classes from './SettingsDialog.module.css';

const languageErrorNotification = 'settings-language-error';

interface SettingsDialogProps {
  opened: boolean;
  onClose: () => void;
  initialPreference: LanguagePreference;
}

export function SettingsDialog({ opened, onClose, initialPreference }: SettingsDialogProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const [preference, setPreference] = useState(initialPreference);
  const [saving, setSaving] = useState(false);

  async function changeLanguage(value: string) {
    const next = languagePreferences.find((option) => option === value);
    if (!next) return;
    setSaving(true);
    try {
      const settings = await resultOf(window.desktop.language.set(next));
      await i18n.changeLanguage(settings.language);
      document.documentElement.lang = settings.language;
      setPreference(settings.preference);
    } catch {
      notifications.show({
        id: languageErrorNotification,
        color: 'red',
        message: t('languageSaveFailed'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t('title')}
      closeButtonProps={{ 'aria-label': t('common:close') }}
      classNames={{
        content: classes.content,
        header: classes.header,
        title: classes.title,
        body: classes.body,
      }}
      size="50rem"
      xOffset="clamp(1rem, 4vw, 3rem)"
      yOffset="clamp(1rem, 4dvh, 3rem)"
      padding={0}
      centered
    >
      <Tabs
        className={classes.layout}
        defaultValue="general"
        orientation="vertical"
        variant="pills"
      >
        <Tabs.List className={classes.categories} aria-label={t('categories')}>
          <Tabs.Tab
            className={classes.category}
            classNames={{ tabLabel: classes.categoryLabel }}
            value="general"
            leftSection={<SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
            data-autofocus
          >
            {t('general')}
          </Tabs.Tab>
          <Tabs.Tab
            className={classes.category}
            classNames={{ tabLabel: classes.categoryLabel }}
            value="transfers"
            leftSection={<ArrowDownUp size={16} strokeWidth={1.5} aria-hidden="true" />}
          >
            {t('transfers')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className={classes.panel} value="general">
          <Stack gap="md">
            <NativeSelect
              classNames={{ root: classes.setting }}
              label={t('language')}
              value={preference}
              disabled={saving}
              onChange={(event) => void changeLanguage(event.currentTarget.value)}
              data={[
                { value: 'system', label: t('followSystem') },
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en', label: 'English' },
              ]}
            />
            <NativeSelect
              classNames={{ root: classes.setting }}
              label={t('appearance')}
              value={colorScheme}
              onChange={(event) => {
                const { value } = event.currentTarget;
                if (isMantineColorScheme(value)) setColorScheme(value);
              }}
              data={[
                { value: 'auto', label: t('followSystem') },
                { value: 'light', label: t('lightTheme') },
                { value: 'dark', label: t('darkTheme') },
              ]}
            />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel className={classes.panel} value="transfers">
          <Stack gap="lg">
            <DownloadSettingsSection />
            <TransferConcurrencySection />
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
