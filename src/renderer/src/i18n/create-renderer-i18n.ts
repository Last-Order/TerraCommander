import { createInstance, type i18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { appLanguages, fallbackLanguage, type AppLanguage } from '../../../shared/language';
import { en } from './en';
import { zhCN } from './zh-CN';

export const rendererNamespaces = ['common', 'settings', 'storage', 'tasks', 'errors'] as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof en;
    strictKeyChecks: true;
  }
}

export async function createRendererI18n(language: AppLanguage): Promise<i18n> {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: fallbackLanguage,
    supportedLngs: appLanguages,
    ns: [...rendererNamespaces],
    defaultNS: 'common',
    resources: { en, 'zh-CN': zhCN },
    interpolation: { escapeValue: false },
  });
  return instance;
}
