import { expect, it, vi } from 'vitest';
import { topLevelEntries } from '../../shared/task-selectors';
import { TaskQueue } from './task-queue';
import type { TaskExecutionOutcome, TaskHandler } from './types';

type Definitions = {
  work: { input: { name: string }; result: void };
  discover: { input: { name: string }; result: void };
};
type Groups = { fixture: { input: { name: string } } };
type Category = 'operation' | 'transfer';
type Outcome = TaskExecutionOutcome<void>;

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const completed: Outcome = { status: 'completed', result: undefined };
const groupRequest = {
  kind: 'fixture' as const,
  input: { name: 'Group' },
};

function setup(
  workOverrides: Partial<TaskHandler<{ name: string }, void, Category>> = {},
  discoverOverrides: Partial<TaskHandler<{ name: string }, void, Category>> = {},
) {
  const work = {
    category: 'transfer' as const,
    conflictKeys: ({ name }: { name: string }) => [name],
    execute: vi.fn<TaskHandler<{ name: string }, void, Category>['execute']>(async () => completed),
    toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' as const } }),
    ...workOverrides,
  };
  const discover = { ...work, category: 'operation' as const, ...discoverOverrides };
  return {
    queue: new TaskQueue<Definitions, Groups, Category>(
      { work, discover },
      { concurrencyLimits: { operation: 16, transfer: 8 } },
    ),
    work,
    discover,
  };
}

it('schedules group children alongside standalone tasks under the same global capacity', async () => {
  const gates = Array.from({ length: 10 }, () => pending<Outcome>());
  const execute = vi.fn<TaskHandler<{ name: string }, void, Category>['execute']>(
    ({ name }) => gates[Number(name)]!.promise,
  );
  const { queue } = setup({ execute });
  const groupId = queue.createGroup(groupRequest)!;
  for (let index = 0; index < 9; index++)
    expect(queue.enqueue({ type: 'work', input: { name: String(index) } }, { groupId })).toBe(true);
  queue.sealGroup(groupId);
  queue.enqueue({ type: 'work', input: { name: '9' } });
  expect(execute).toHaveBeenCalledTimes(8);
  expect(topLevelEntries(queue.store.getState().tasks, queue.store.getState().groups)).toHaveLength(
    2,
  );
  gates[0]!.resolve(completed);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(9));
  gates[1]!.resolve(completed);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(10));
  for (const gate of gates) gate.resolve(completed);
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    }),
  );
});

it('retains finished children of unfinished groups and releases history only as a whole', async () => {
  const gate = pending<Outcome>();
  const release = vi.fn(async () => {});
  const onSettled = vi.fn(async () => {});
  const { queue } = setup({
    execute: async ({ name }) => (name === 'active' ? gate.promise : completed),
  });
  const groupId = queue.createGroup(groupRequest, { release, onSettled })!;
  queue.enqueue({ type: 'work', input: { name: 'finished' } }, { groupId });
  queue.enqueue({ type: 'work', input: { name: 'active' } }, { groupId });
  queue.sealGroup(groupId);
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(2);
  expect(release).not.toHaveBeenCalled();
  gate.resolve(completed);
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    }),
  );
  expect(onSettled).toHaveBeenCalledOnce();
  queue.clearFinished();
  expect(queue.store.getState()).toMatchObject({ tasks: [], groups: [] });
  expect(release).toHaveBeenCalledOnce();
});

it('aggregates skipped, failed and successful outcomes and retries a single member', async () => {
  let failed = true;
  const onSettled = vi.fn(async () => {});
  const { queue } = setup({
    execute: async ({ name }) => {
      if (name === 'skip') return { status: 'skipped' };
      if (name === 'fail' && failed) {
        return {
          status: 'failed',
          failure: { code: 'failed', message: { key: 'tasks:unknownError' } },
        };
      }
      return completed;
    },
    retry: async () => {},
  });
  const groupId = queue.createGroup(groupRequest, { onSettled })!;
  for (const name of ['ok', 'skip', 'fail'])
    queue.enqueue({ type: 'work', input: { name } }, { groupId });
  queue.sealGroup(groupId);
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      state: { phase: 'settled', outcome: 'partial' },
      summary: { completed: 1, skipped: 1, failed: 1 },
    }),
  );
  failed = false;
  const task = queue.store.getState().tasks.find((task) => task.status === 'failed')!;
  await queue.retry(task.id);
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      state: { phase: 'settled', outcome: 'completed' },
      summary: { completed: 2, skipped: 1, failed: 0 },
    }),
  );
  expect(onSettled).toHaveBeenCalledTimes(2);
});

it('reserves group resources without conflicting with its own members until settlement finishes', async () => {
  const settlement = pending<void>();
  const { queue } = setup();
  const groupId = queue.createGroup(
    { ...groupRequest, resources: ['shared'] },
    { onSettled: () => settlement.promise },
  )!;
  expect(queue.enqueue({ type: 'work', input: { name: 'shared' } })).toBe(false);
  expect(queue.enqueue({ type: 'work', input: { name: 'shared' } }, { groupId })).toBe(true);
  queue.sealGroup(groupId);
  await vi.waitFor(() => expect(queue.store.getState().groups[0]?.state.phase).toBe('settling'));
  expect(queue.createGroup({ ...groupRequest, resources: ['shared'] })).toBeUndefined();
  queue.clearFinished();
  expect(queue.store.getState().groups).toHaveLength(1);
  settlement.resolve();
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]?.state).toEqual({
      phase: 'settled',
      outcome: 'completed',
    }),
  );
  expect(queue.enqueue({ type: 'work', input: { name: 'shared' } })).toBe(true);
});

it('deduplicates membership keys and waits for bounded work capacity', async () => {
  const gate = pending<Outcome>();
  const { queue } = setup({ execute: async () => gate.promise });
  const groupId = queue.createGroup(groupRequest)!;
  queue.enqueue({ type: 'work', input: { name: 'first' } }, { groupId, memberKey: 'first' });
  expect(queue.hasGroupMember(groupId, 'first')).toBe(true);
  expect(
    queue.enqueue({ type: 'work', input: { name: 'different' } }, { groupId, memberKey: 'first' }),
  ).toBe(false);
  const controller = new AbortController();
  const available = vi.fn();
  const wait = queue.waitForGroupCapacity(groupId, controller.signal, 1).then(available);
  expect(available).not.toHaveBeenCalled();
  gate.resolve(completed);
  await wait;
  expect(available).toHaveBeenCalledOnce();
  queue.sealGroup(groupId);
});

it('stops preparation waiting for capacity when the session closes', async () => {
  const release = vi.fn(async () => {});
  const { queue } = setup({
    execute: async (_input, context) => {
      await new Promise<void>((resolve) =>
        context.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return { status: 'cancelled' };
    },
    cancel: async () => {},
  });
  queue.createGroup(groupRequest, {
    release,
    prepare: async (context) => {
      for (let index = 0; index < 65; index++)
        await context.enqueue({ type: 'work', input: { name: String(index) } });
    },
  });
  await vi.waitFor(() => expect(queue.store.getState().tasks).toHaveLength(64));
  await queue.dispose();
  expect(queue.store.getState().tasks).toHaveLength(64);
  expect(queue.store.getState().groups[0]).toMatchObject({
    preparation: { status: 'cancelled' },
    state: { phase: 'settled', outcome: 'cancelled' },
  });
  expect(release).toHaveBeenCalledOnce();
  expect(queue.enqueue({ type: 'work', input: { name: 'late' } })).toBe(false);
});

it('finishes an empty group after successful preparation', async () => {
  const { queue } = setup();
  queue.createGroup(groupRequest, { prepare: async () => {} });
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      state: { phase: 'settled', outcome: 'completed' },
      summary: { total: 0 },
      preparation: { status: 'completed' },
    }),
  );
});

it('keeps preparation issues outside member counts and preserves successful member results', async () => {
  const { queue } = setup();
  queue.createGroup(groupRequest, {
    prepare: async (context) => {
      context.reportIssue({
        label: 'unavailable source',
        failure: { code: 'blocked', message: { key: 'tasks:unknownError' } },
      });
      await context.enqueue({ type: 'work', input: { name: 'successful' } });
    },
  });
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      state: { phase: 'settled', outcome: 'partial' },
      summary: { total: 1, completed: 1, failed: 0 },
      preparation: { status: 'completed', issues: [{ label: 'unavailable source' }] },
    }),
  );
});

it('reports fatal preparation failure without creating a placeholder task', async () => {
  const { queue } = setup();
  const onPreparationFailure = vi.fn();
  queue.createGroup(groupRequest, {
    prepare: async () => {
      throw new Error('private provider body');
    },
    toFailure: () => ({ code: 'blocked', message: { key: 'tasks:unknownError' } }),
    onPreparationFailure,
  });
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      state: { phase: 'settled', outcome: 'failed' },
      preparation: { status: 'failed', failure: { code: 'blocked' } },
    }),
  );
  expect(queue.store.getState().tasks).toHaveLength(0);
  expect(onPreparationFailure).toHaveBeenCalledExactlyOnceWith({
    code: 'blocked',
    message: { key: 'tasks:unknownError' },
  });
});

it('does not finish while preparation is still active after an early member completes', async () => {
  const start = pending<void>();
  const finish = pending<void>();
  const { queue } = setup();
  const groupId = queue.createGroup(groupRequest, {
    prepare: async (context) => {
      await start.promise;
      expect(await context.enqueue({ type: 'work', input: { name: 'early' } }, 'same')).toBe(true);
      expect(await context.enqueue({ type: 'work', input: { name: 'early' } }, 'same')).toBe(true);
      await finish.promise;
    },
  })!;
  expect(queue.store.getState().tasks).toHaveLength(0);
  expect(queue.store.getState().groups[0]?.progress.kind).toBe('indeterminate');
  start.resolve();
  await vi.waitFor(() => expect(queue.store.getState().tasks[0]?.status).toBe('completed'));
  expect(queue.store.getState().groups[0]).toMatchObject({
    state: { phase: 'active' },
    sealed: false,
    summary: { total: 1 },
  });
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(1);
  finish.resolve();
  await vi.waitFor(() =>
    expect(queue.store.getState().groups[0]).toMatchObject({
      sealed: true,
      state: { phase: 'settled', outcome: 'completed' },
      summary: { total: 1, completed: 1 },
      preparation: { status: 'completed' },
    }),
  );
  expect(queue.enqueue({ type: 'work', input: { name: 'late' } }, { groupId })).toBe(false);
});

it('bounds concurrent preparations independently of task capacity', async () => {
  const gates = Array.from({ length: 6 }, () => pending<void>());
  const execute = vi.fn<TaskHandler<{ name: string }, void, Category>['execute']>(
    async () => completed,
  );
  const { queue } = setup({ execute });
  const starts = vi.fn();
  for (const [index, gate] of gates.entries())
    queue.createGroup(groupRequest, {
      prepare: async () => {
        starts(index);
        await gate.promise;
      },
    });
  expect(starts).toHaveBeenCalledTimes(4);
  expect(queue.store.getState().groups[4]?.preparation.status).toBe('queued');
  for (let index = 0; index < 8; index++)
    queue.enqueue({ type: 'work', input: { name: String(index) } });
  expect(execute).toHaveBeenCalledTimes(8);
  gates[0]!.resolve();
  await vi.waitFor(() => expect(starts).toHaveBeenCalledTimes(5));
  for (const gate of gates) gate.resolve();
  await vi.waitFor(() =>
    expect(
      queue.store
        .getState()
        .groups.every(
          (group) => group.state.phase === 'settled' && group.state.outcome === 'completed',
        ),
    ).toBe(true),
  );
});
