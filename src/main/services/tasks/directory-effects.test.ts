import { expect, it } from 'vitest';
import type { Entry, EntryRef } from '@shared/storage';
import {
  projectDirectoryEffects,
  type DirectoryEffectGroup,
  type DirectoryEffectTask,
} from './directory-effects';

const parent: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'folder' };
const otherParent: EntryRef = { connectionId: 'conn', spaceId: 'drive', locator: 'other' };

function makeEntry(locator: string, name: string): Entry {
  return {
    ref: { ...parent, locator },
    name,
    kind: 'file',
    capabilities: {},
  };
}

it('projects active tasks into deduplicated busy entries and optimistic renames', () => {
  const fileA = makeEntry('a', 'a.txt');
  const fileB = makeEntry('b', 'b.txt');
  const fileC = makeEntry('c', 'c.txt');
  const fileD = makeEntry('d', 'd.txt');
  const fileE = makeEntry('e', 'e.txt');
  const fileF = makeEntry('f', 'f.txt');
  const fileG = makeEntry('g', 'g.txt');

  const tasks: DirectoryEffectTask[] = [
    {
      status: 'running',
      request: { type: 'rename', input: { parent, entry: fileA, name: 'a2.txt' } },
    },
    {
      status: 'queued',
      request: { type: 'delete', input: { entry: fileB } },
    },
    {
      status: 'completed',
      request: { type: 'transfer', input: { display: { entry: fileC } } },
    },
    {
      status: 'paused',
      request: { type: 'move', input: { entry: fileD } },
    },
    {
      status: 'running',
      request: { type: 'transfer', input: { display: { entry: fileE } } },
    },
    {
      status: 'running',
      request: { type: 'copy', input: { entry: fileF } },
    },
    {
      status: 'running',
      request: { type: 'copy', input: { entry: fileG, removeSourceAfterCopy: true } },
    },
    {
      status: 'running',
      request: { type: 'create-directory', input: { parent: otherParent, name: 'new' } },
    },
  ];

  const effects = projectDirectoryEffects(tasks, []);

  expect(effects).toEqual({
    busyEntries: [fileA.ref, fileB.ref, fileD.ref, fileE.ref, fileG.ref],
    renames: [{ parent, entry: fileA.ref, name: 'a2.txt' }],
  });
});

it('projects active groups without duplicating task locks and ignores settled or copy groups', () => {
  const fileA = makeEntry('a', 'a.txt');
  const fileB = makeEntry('b', 'b.txt');
  const fileC = makeEntry('c', 'c.txt');
  const fileD = makeEntry('d', 'd.txt');
  const fileE = makeEntry('e', 'e.txt');

  const tasks: DirectoryEffectTask[] = [
    {
      status: 'running',
      request: { type: 'rename', input: { parent, entry: fileA, name: 'new.txt' } },
    },
  ];
  const groups: DirectoryEffectGroup[] = [
    {
      state: { phase: 'active' },
      request: { kind: 'transfer', input: { sourceEntries: [fileA.ref, fileB.ref] } },
    },
    {
      state: { phase: 'settling' },
      request: { kind: 'move', input: { entries: [fileC.ref] } },
    },
    {
      state: { phase: 'settled', outcome: 'completed' },
      request: { kind: 'delete', input: { entries: [fileD.ref] } },
    },
    {
      state: { phase: 'active' },
      request: { kind: 'copy', input: { entries: [fileE.ref] } },
    },
  ];

  const effects = projectDirectoryEffects(tasks, groups);

  expect(effects).toEqual({
    busyEntries: [fileA.ref, fileB.ref, fileC.ref],
    renames: [{ parent, entry: fileA.ref, name: 'new.txt' }],
  });
});
