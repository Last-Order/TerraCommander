import log from 'electron-log/main';
import Store from 'electron-store';
import { z } from 'zod';
import {
  fallbackLanguage,
  languagePreferences,
  type AppLanguage,
  type LanguagePreference,
  type LanguageSettings,
} from '../../shared/language';

export const languagePreferenceSchema = z.enum(languagePreferences);

export function resolveAppLanguage(
  preference: LanguagePreference,
  systemLanguages: readonly string[],
): AppLanguage {
  if (preference !== 'system') return preference;
  for (const tag of systemLanguages) {
    try {
      const { language, script } = new Intl.Locale(tag).maximize();
      if (language === 'en') return 'en';
      if (language === 'zh' && script === 'Hans') return 'zh-CN';
    } catch {
      // Skip malformed system language tags and try the next preference.
    }
  }
  return fallbackLanguage;
}

export function createLanguagePreferences(profilePath: string, systemLanguages: () => string[]) {
  let store: Store<{ language: unknown }> | undefined;

  function openStore() {
    return (store ??= new Store({ cwd: profilePath, name: 'interface', clearInvalidConfig: true }));
  }

  function resolve(preference: LanguagePreference): LanguageSettings {
    let languages: string[] = [];
    if (preference === 'system') {
      try {
        languages = systemLanguages();
      } catch {
        log.warn('Could not determine the preferred system languages');
      }
    }
    return { preference, language: resolveAppLanguage(preference, languages) };
  }

  let preference: LanguagePreference = 'system';
  try {
    const saved = languagePreferenceSchema.safeParse(openStore().get('language'));
    if (saved.success) preference = saved.data;
  } catch {
    log.warn('Could not read the interface language preference');
  }
  let settings = resolve(preference);

  return {
    get: () => settings,
    set(next: LanguagePreference): LanguageSettings | null {
      const updated = resolve(next);
      try {
        openStore().set('language', next);
      } catch {
        log.warn('Could not save the interface language preference');
        return null;
      }
      settings = updated;
      return settings;
    },
  };
}

export type LanguagePreferences = ReturnType<typeof createLanguagePreferences>;
