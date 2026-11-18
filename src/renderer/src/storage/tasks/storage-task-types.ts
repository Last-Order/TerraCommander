import type { Entry, EntryRef } from '../../../../shared/storage';
import type { DownloadWork, PreparedDownloadBatch } from '../../../../shared/downloads';

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

export type StorageTaskGroupDefinitions = {
  download: { input: { names: readonly string[]; sourcePath: string; destinationPath: string } };
};

export interface DownloadGroupInput {
  parent: EntryRef;
  entries: readonly Entry[];
  directoryPath: string;
  destination: PreparedDownloadBatch;
}

export interface DownloadTaskInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
  destination: DownloadWork;
  displayName?: string;
}

export interface DeleteTaskInput {
  parent: EntryRef;
  entry: Entry;
  directoryPath: string;
}
