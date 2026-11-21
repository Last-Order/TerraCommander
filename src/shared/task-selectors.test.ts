import { expect, it } from 'vitest';
import { topLevelEntries, type PresentableGroup } from './task-selectors';

function group(id: number): PresentableGroup {
  return {
    id,
    state: { phase: 'active' },
    sealed: true,
    preparation: { status: 'completed' },
    summary: { running: 1, queued: 0, paused: 0 },
  };
}

it('orders standalone tasks and groups newest first while excluding group members', () => {
  const entries = topLevelEntries(
    [
      { id: 1, status: 'completed' },
      { id: 3, status: 'running', groupId: 2 },
      { id: 4, status: 'queued' },
    ],
    [group(2), group(5)],
  );

  expect(entries.map(({ kind, id }) => `${kind}:${id}`)).toEqual([
    'group:5',
    'task:4',
    'group:2',
    'task:1',
  ]);
});
