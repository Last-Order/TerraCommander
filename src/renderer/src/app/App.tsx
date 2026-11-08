import { MantineProvider } from '@mantine/core';
import { StorageWorkspace } from '../storage/StorageWorkspace';
import { theme } from './theme';

export function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <StorageWorkspace />
    </MantineProvider>
  );
}
