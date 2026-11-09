import { useState } from 'react';
import { Modal, NativeSelect, Tabs } from '@mantine/core';
import { SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { languagePreferences, type LanguagePreference } from '../../../shared/language';
import classes from './SettingsDialog.module.css';

interface SettingsDialogProps {
  opened: boolean;
  onClose: () => void;
  initialPreference: LanguagePreference;
}

export function SettingsDialog({ opened, onClose, initialPreference }: SettingsDialogProps) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const [preference, setPreference] = useState(initialPreference);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function changeLanguage(value: string) {
    const next = languagePreferences.find((option) => option === value);
    if (!next) return;
    setSaving(true);
    setFailed(false);
    try {
      const settings = await window.desktop.language.set(next);
      if (settings) {
        await i18n.changeLanguage(settings.language);
        document.documentElement.lang = settings.language;
        setPreference(settings.preference);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
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
      size="64rem"
      xOffset="clamp(1rem, 4vw, 3rem)"
      yOffset="clamp(1rem, 4dvh, 3rem)"
      padding={0}
      radius="md"
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
            leftSection={<SlidersHorizontal size={16} aria-hidden="true" />}
            data-autofocus
          >
            {t('general')}
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className={classes.panel} value="general">
          <NativeSelect
            classNames={{ root: classes.setting, error: classes.settingError }}
            label={t('language')}
            value={preference}
            disabled={saving}
            error={failed && <span role="alert">{t('languageSaveFailed')}</span>}
            onChange={(event) => void changeLanguage(event.currentTarget.value)}
            data={[
              { value: 'system', label: t('systemLanguage') },
              { value: 'zh-CN', label: '简体中文' },
              { value: 'en', label: 'English' },
            ]}
          />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
