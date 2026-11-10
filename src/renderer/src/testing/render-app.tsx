import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SWRConfig } from 'swr';
import { App } from '../app/App';
import { createRendererI18n } from '../i18n/create-renderer-i18n';

export async function renderWorkspace() {
  const i18n = await createRendererI18n('zh-CN');
  render(
    <StrictMode>
      <SWRConfig value={{ provider: () => new Map() }}>
        <I18nextProvider i18n={i18n}>
          <App languagePreference="system" />
        </I18nextProvider>
      </SWRConfig>
    </StrictMode>,
  );
}
