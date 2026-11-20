import { ActionIcon, Button, Modal, createTheme, localStorageColorSchemeManager } from '@mantine/core';
import classes from './theme.module.css';

export const defaultColorScheme = 'auto';
export const colorSchemeManager = localStorageColorSchemeManager();

export const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: { light: 9, dark: 3 },
  autoContrast: true,
  defaultRadius: 'md',
  spacing: { xs: '0.5rem' },
  focusClassName: classes.focus!,
  headings: { fontWeight: '600' },
  components: {
    ActionIcon: ActionIcon.extend({ defaultProps: { size: 32 } }),
    Button: Button.extend({ defaultProps: { fw: 500 } }),
    Modal: Modal.extend({ defaultProps: { radius: 'lg' } }),
  },
});
