export const fallbackLanguage = 'en';
export const appLanguages = [fallbackLanguage, 'zh-CN'] as const;
export const languagePreferences = ['system', ...appLanguages] as const;

export type AppLanguage = (typeof appLanguages)[number];
export type LanguagePreference = (typeof languagePreferences)[number];

export interface LanguageSettings {
  preference: LanguagePreference;
  language: AppLanguage;
}

export const defaultLanguageSettings: LanguageSettings = {
  preference: 'system',
  language: fallbackLanguage,
};
