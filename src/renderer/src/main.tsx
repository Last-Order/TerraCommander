import '@mantine/core/styles.css';
import './styles/global.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { defaultLanguageSettings } from '../../shared/language';
import { App } from './app/App';
import { createRendererI18n } from './i18n/i18n';

async function start() {
  const root = document.getElementById('root');
  if (!root) throw new Error('Application root is missing');
  const settings = await window.desktop.language.get().catch(() => defaultLanguageSettings);
  const i18n = await createRendererI18n(settings.language);
  document.documentElement.lang = settings.language;
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App languagePreference={settings.preference} />
      </I18nextProvider>
    </StrictMode>,
  );
}

void start();
