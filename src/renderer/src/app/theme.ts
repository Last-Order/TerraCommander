import {
  ActionIcon,
  Button,
  Menu,
  Modal,
  createTheme,
  localStorageColorSchemeManager,
  type MantineColorsTuple,
} from '@mantine/core';
import classes from './theme.module.css';

const water: MantineColorsTuple = [
  '#f0f8fc',
  '#dff0f9',
  '#c5e4f5',
  '#a3d3ec',
  '#7ec0e3',
  '#5baad4',
  '#3f90bc',
  '#276f95',
  '#1f5b7c',
  '#174762',
];

const waterGray: MantineColorsTuple = [
  '#f1f7fa',
  '#e7f1f7',
  '#dbe9f1',
  '#cadce7',
  '#b4cbd9',
  '#8ba5b5',
  '#587181',
  '#415866',
  '#2d414e',
  '#1d2e3a',
];

const waterDark: MantineColorsTuple = [
  '#dce8f0',
  '#b8cbd7',
  '#8ba4b4',
  '#627c8d',
  '#324552',
  '#263640',
  '#1e2b33',
  '#162026',
  '#111a20',
  '#0c1317',
];

export const defaultColorScheme = 'auto';
export const colorSchemeManager = localStorageColorSchemeManager();

export const theme = createTheme({
  white: '#f9fcfe',
  black: '#1d2e3a',
  colors: {
    water,
    gray: waterGray,
    dark: waterDark,
  },
  primaryColor: 'water',
  primaryShade: { light: 7, dark: 3 },
  autoContrast: true,
  defaultRadius: 'md',
  spacing: { xs: '0.5rem' },
  focusClassName: classes.focus!,
  headings: { fontWeight: '600' },
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: { size: 32 },
      classNames: { root: classes.quietActionIcon! },
    }),
    Button: Button.extend({ defaultProps: { fw: 500 } }),
    Menu: Menu.extend({
      classNames: { dropdown: classes.menuDropdown! },
    }),
    Modal: Modal.extend({ defaultProps: { radius: 'lg' } }),
  },
});
