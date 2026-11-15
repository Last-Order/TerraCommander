import type { Entry, EntryRef } from '../../../../shared/storage';
import type { PreparedDownload } from '../../../../shared/downloads';

export interface RenameTaskInput {
  parent: EntryRef;
  entry: Entry;
  name: string;
  directoryPath: string;
}

export type StorageTaskDefinitions = {
  rename: { input: RenameTaskInput; result: Entry };
  delete: { input: DeleteTaskInput; result: void };
  download: { input: DownloadTaskInput; result: void };
};

export interface DownloadTaskInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
  destination: PreparedDownload;
}

export interface DeleteTaskInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
}
