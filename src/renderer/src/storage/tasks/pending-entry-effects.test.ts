import { expect, it } from 'vitest';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { directoryKey } from '../directory/directory-cache';
import { selectPendingEntryEffects } from './pending-entry-effects';
import type { StorageTaskGroupItem, StorageTaskItem } from './storage-task-types';

const parent: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'folder' };
const otherParent: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'other' };

const idleControls = {
  supportsPause: false,
  supportsCancel: false,
  canPause: false,
  canResume: false,
  canCancel: false,
  canRetry: false,
};

function makeEntry(locator: string, name: string): Entry {
  return {
    ref: { ...parent, locator },
    name,
    kind: 'file',
    capabilities: {},
  };
}

function makeGroup(
  id: number,
  phase: 'active' | 'settling' | 'settled',
  resources: readonly string[],
): StorageTaskGroupItem {
  return {
    id,
    request: {
      kind: 'download',
      input: { names: ['a'], sourcePath: '/', destinationPath: 'D:\\' },
      resources,
    },
    sealed: true,
    state: phase === 'settled' ? { phase: 'settled', outcome: 'completed' } : { phase },
    summary: {
      total: 1,
      queued: 0,
      running: phase === 'settled' ? 0 : 1,
      paused: 0,
      completed: phase === 'settled' ? 1 : 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    },
    progress: { kind: 'indeterminate' },
    preparation: { status: 'completed', issues: [] },
  };
}

it('projects active task effects in the target directory and ignores finished or foreign tasks', () => {
  const fileA = makeEntry('a', 'a.txt');
  const fileB = makeEntry('b', 'b.txt');
  const fileC = makeEntry('c', 'c.txt');
  const foreignFile = { ...makeEntry('d', 'd.txt'), ref: { ...otherParent, locator: 'd' } };
  const entries = new Map([
    [fileA.ref.locator, fileA],
    [fileB.ref.locator, fileB],
    [fileC.ref.locator, fileC],
  ]);

  const tasks: StorageTaskItem[] = [
    {
      id: 1,
      request: {
        type: 'rename',
        input: { parent, entry: fileA, name: 'a2.txt', directoryPath: '/' },
      },
      status: 'running',
      controls: idleControls,
    },
    {
      id: 2,
      request: { type: 'delete', input: { parent, entry: fileB, directoryPath: '/' } },
      status: 'queued',
      controls: idleControls,
    },
    {
      id: 3,
      request: {
        type: 'download',
        input: { parent, entry: fileC, directoryPath: '/', destinationPath: 'D:\\c.txt' },
      },
      status: 'completed',
      controls: idleControls,
      result: undefined,
    },
    {
      id: 4,
      request: {
        type: 'delete',
        input: { parent: otherParent, entry: foreignFile, directoryPath: '/other' },
      },
      status: 'running',
      controls: idleControls,
    },
  ];

  const effects = selectPendingEntryEffects(tasks, [], entries, parent);
  expect(effects.get('a')).toEqual({ busy: true, optimisticName: 'a2.txt' });
  expect(effects.get('b')).toEqual({ busy: true });
  expect(effects.has('c')).toBe(false);
  expect(effects.has('d')).toBe(false);
});

it('projects active group resource locks without marking settled groups or discarding optimistic names', () => {
  const folder = makeEntry('dir-1', 'Docs');
  const renamed = makeEntry('file-1', 'old.txt');
  const settledTarget = makeEntry('file-2', 'done.txt');
  const entries = new Map([
    [folder.ref.locator, folder],
    [renamed.ref.locator, renamed],
    [settledTarget.ref.locator, settledTarget],
  ]);

  const tasks: StorageTaskItem[] = [
    {
      id: 1,
      request: {
        type: 'rename',
        input: { parent, entry: renamed, name: 'new.txt', directoryPath: '/' },
      },
      status: 'running',
      controls: idleControls,
    },
  ];
  const groups: StorageTaskGroupItem[] = [
    makeGroup(10, 'active', [directoryKey(folder.ref), directoryKey(renamed.ref)]),
    makeGroup(11, 'settled', [directoryKey(settledTarget.ref)]),
  ];

  const effects = selectPendingEntryEffects(tasks, groups, entries, parent);
  expect(effects.get('dir-1')).toEqual({ busy: true });
  expect(effects.get('file-1')).toEqual({ busy: true, optimisticName: 'new.txt' });
  expect(effects.has('file-2')).toBe(false);
});
