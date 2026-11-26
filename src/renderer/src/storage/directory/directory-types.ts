import type { Entry } from '@shared/storage';

export interface DirectorySort {
  field: 'name' | 'modifiedAt' | 'size';
  direction: 'ascending' | 'descending';
}

export interface DirectoryRow {
  entry: Entry;
  name: string;
  modifiedAt: number | undefined;
  size: number | undefined;
}

export interface DirectorySelectionModifiers {
  toggle: boolean;
  range: boolean;
}

export type DirectoryViewportAlignment = 'auto' | 'center';

export interface DirectoryViewportCommand {
  seq: number;
  locator: string;
  align: DirectoryViewportAlignment;
  focus: boolean;
}

export interface DirectoryViewportRequest {
  locator: string;
  align?: DirectoryViewportAlignment | undefined;
  focus?: boolean | undefined;
}
