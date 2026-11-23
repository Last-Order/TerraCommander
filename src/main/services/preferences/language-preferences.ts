import { z } from 'zod';
import { AccountError } from '@main/accounts/core/errors';
import {
  fallbackLanguage,
  languagePreferences,
  type AppLanguage,
  type LanguagePreference,
  type LanguageSettings,
} from '@shared/language';

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

export interface LanguageSnapshotStore {
  read(): unknown;
  write(preference: LanguagePreference): void;
}

export class LanguagePreferences {
  private settings: LanguageSettings;

  constructor(
    private readonly store: LanguageSnapshotStore,
    private readonly systemLanguages: () => readonly string[],
    private readonly onWarn: (message: string) => void = () => {},
  ) {
    let preference: LanguagePreference = 'system';
    try {
      const saved = languagePreferenceSchema.safeParse(this.store.read());
      if (saved.success) preference = saved.data;
    } catch {
      this.onWarn('Could not read the interface language preference');
    }
    this.settings = this.resolve(preference);
  }

  get = (): LanguageSettings => this.settings;

  set = (next: LanguagePreference): LanguageSettings => {
    const updated = this.resolve(next);
    try {
      this.store.write(next);
    } catch (error) {
      this.onWarn('Could not save the interface language preference');
      throw new AccountError('PersistenceFailed', error);
    }
    this.settings = updated;
    return this.settings;
  };

  private resolve(preference: LanguagePreference): LanguageSettings {
    let languages: readonly string[] = [];
    if (preference === 'system') {
      try {
        languages = this.systemLanguages();
      } catch {
        this.onWarn('Could not determine the preferred system languages');
      }
    }
    return { preference, language: resolveAppLanguage(preference, languages) };
  }
}

export type LanguagePreferencesPort = Pick<LanguagePreferences, 'get' | 'set'>;
