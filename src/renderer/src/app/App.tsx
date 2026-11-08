import { MantineProvider } from '@mantine/core';
import { SWRConfig } from 'swr';
import { StorageWorkspace } from '../storage/StorageWorkspace';
import { theme } from './theme';

export function App() {
  return (
    <SWRConfig
      value={{
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        shouldRetryOnError: false,
      }}
    >
      <MantineProvider theme={theme} defaultColorScheme="auto">
        <StorageWorkspace />
      </MantineProvider>
    </SWRConfig>
  );
}
