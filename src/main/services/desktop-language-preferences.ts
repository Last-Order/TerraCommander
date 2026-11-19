import log from 'electron-log/main';
import Store from 'electron-store';
import type { LanguagePreference } from '../../shared/language';
import { LanguagePreferences } from './language-preferences';

export function createDesktopLanguagePreferences(
  profilePath: string,
  systemLanguages: () => string[],
): LanguagePreferences {
  const store = new Store<{ language: unknown }>({
    cwd: profilePath,
    name: 'interface',
    clearInvalidConfig: true,
  });
  return new LanguagePreferences(
    {
      read: () => store.get('language'),
      write: (preference: LanguagePreference) => store.set('language', preference),
    },
    systemLanguages,
    (message) => log.warn(message),
  );
}
