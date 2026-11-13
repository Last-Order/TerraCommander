import type { Entry } from '../../../../shared/storage';

export interface DirectorySort {
  field: 'name' | 'modifiedAt' | 'size';
  direction: 'ascending' | 'descending';
}

export interface DirectoryRow {
  entry: Entry;
  name: string;
  disabled: boolean;
  modifiedAt: number | undefined;
  size: number | undefined;
}

export interface DirectorySelectionModifiers {
  toggle: boolean;
  range: boolean;
}

export interface DirectoryRevealTarget {
  locator: string;
}
