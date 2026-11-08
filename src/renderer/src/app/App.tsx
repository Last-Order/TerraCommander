import { MantineProvider } from '@mantine/core';
import { SWRConfig } from 'swr';
import type { LanguagePreference } from '../../../shared/language';
import { StorageWorkspace } from '../storage/StorageWorkspace';
import { LanguagePicker } from './LanguagePicker';
import { theme } from './theme';

export function App({ languagePreference }: { languagePreference: LanguagePreference }) {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        shouldRetryOnError: false,
      }}
    >
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <StorageWorkspace
          languageControl={<LanguagePicker initialPreference={languagePreference} />}
        />
      </MantineProvider>
    </SWRConfig>
  );
}
