import type { Entry, EntryRef } from '../../../../shared/storage';

export interface RenameTaskInput {
  parent: EntryRef;
  entry: Entry;
  name: string;
  directoryPath: string;
}

export type StorageTaskDefinitions = {
  rename: { input: RenameTaskInput; result: Entry };
};
