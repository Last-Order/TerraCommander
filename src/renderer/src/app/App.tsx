import { MantineProvider } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { SWRConfig } from 'swr';
import type { LanguagePreference } from '../../../shared/language';
import { SettingsDialog } from '../settings/SettingsDialog';
import { StorageWorkspace } from '../storage/StorageWorkspace';
import { theme } from './theme';

export function App({ languagePreference }: { languagePreference: LanguagePreference }) {
  const [settingsOpened, settings] = useDisclosure();

  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        shouldRetryOnError: false,
      }}
    >
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <StorageWorkspace onOpenSettings={settings.open} />
        <SettingsDialog
          opened={settingsOpened}
          onClose={settings.close}
          initialPreference={languagePreference}
        />
      </MantineProvider>
    </SWRConfig>
  );
}
