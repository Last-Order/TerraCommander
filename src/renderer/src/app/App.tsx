import { MantineProvider } from '@mantine/core';
import { theme } from './theme';
import classes from './App.module.css';

export function App() {
  return (
    <MantineProvider theme={theme}>
      <div className={classes.root} />
    </MantineProvider>
  );
}
