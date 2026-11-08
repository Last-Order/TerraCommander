import { useState } from 'react';
import { NativeSelect } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { languagePreferences, type LanguagePreference } from '../../../shared/language';

export function LanguagePicker({ initialPreference }: { initialPreference: LanguagePreference }) {
  const { t, i18n } = useTranslation();
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
    <NativeSelect
      size="xs"
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
  );
}
