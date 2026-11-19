import { expect, it, vi } from 'vitest';
import { summarizeTasks } from '../../shared/task-selectors';
import { deferred } from '../testing/deferred';
import { TaskQueue } from './task-queue';
import type { TaskContext, TaskExecutionOutcome, TaskHandler } from './types';

type Definitions = {
  transfer: { input: string; result: void };
  operation: { input: string; result: void };
};
type Category = 'operation' | 'transfer';

function setup(category: Category = 'transfer') {
  const executions: {
    input: string;
    context: TaskContext;
    pending: ReturnType<typeof deferred<TaskExecutionOutcome<void>>>;
  }[] = [];
  const onSuccess = vi.fn();
  const onFailure = vi.fn();
  const pause = vi.fn(async (input: string) => {
    executions
      .findLast((execution) => execution.input === input)
      ?.pending.resolve({ status: 'paused' });
  });
  const handler: TaskHandler<string, void, Category> = {
    category,
    conflictKeys: (input) => [input],
    execute: async (input, context) => {
      const pending = deferred<TaskExecutionOutcome<void>>();
      executions.push({ input, context, pending });
      context.reportControls({ cancellable: true, pausable: true });
      context.reportProgress({
        kind: 'determinate',
        completed: 4,
        total: 10,
        unit: 'bytes',
      });
      return pending.promise;
    },
    pause,
    cancel: vi.fn(async () => {}),
    onSuccess,
    onFailure,
    toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' } }),
  };
  const queue = new TaskQueue<Definitions, Record<string, { input: unknown }>, Category>(
    {
      transfer: handler,
      operation: {
        category: 'operation',
        conflictKeys: (input) => [input],
        execute: async (_input, context) => {
          context.reportControls({ cancellable: true, pausable: true });
          context.reportProgress({ kind: 'indeterminate' });
          return { status: 'completed', result: undefined };
        },
        toFailure: () => ({ code: 'failed', message: { key: 'tasks:unknownError' } }),
      },
    },
    { concurrencyLimits: { operation: 16, transfer: 8 } },
  );
  const task = (id: number) => {
    const current = queue.store.getState().tasks.find((candidate) => candidate.id === id);
    if (!current) throw new Error('Missing task');
    return current;
  };
  return { queue, handler, pause, executions, onSuccess, onFailure, task };
}

it('requires a running task, handler support and current pause availability', async () => {
  const { queue, pause, executions, task } = setup();
  for (let index = 0; index < 9; index++)
    queue.enqueue({ type: 'transfer', input: `file-${index}` });
  queue.enqueue({ type: 'operation', input: 'rename' });
  expect(queue.canPause(task(1))).toBe(true);
  expect(queue.canPause(task(9))).toBe(false);
  expect(queue.canPause(task(10))).toBe(false);
  await queue.pause(9);
  await queue.pause(10);
  expect(pause).not.toHaveBeenCalled();
  executions[0]?.context.reportControls({ cancellable: true, pausable: false });
  await queue.pause(1);
  expect(pause).not.toHaveBeenCalled();
  expect(task(1).status).toBe('running');
});

it('keeps control availability independent from progress and preserves measurements on pause', async () => {
  const { queue, executions, task } = setup('operation');
  queue.enqueue({ type: 'transfer', input: 'file' });
  const execution = executions[0];
  if (!execution) throw new Error('Missing execution');
  const progress = { kind: 'determinate', completed: 2, total: 5, unit: 'items' } as const;
  execution.context.reportProgress(progress);
  execution.context.reportControls({ cancellable: false, pausable: false });
  expect(task(1).progress).toBe(progress);
  expect(queue.canCancel(task(1))).toBe(false);
  expect(queue.canPause(task(1))).toBe(false);
  execution.context.reportProgress({ ...progress, completed: 3 });
  expect(queue.canCancel(task(1))).toBe(false);
  expect(queue.canPause(task(1))).toBe(false);
  execution.context.reportControls({ cancellable: true, pausable: true });
  expect(queue.canCancel(task(1))).toBe(true);
  expect(queue.canPause(task(1))).toBe(true);
  const latest = task(1).progress;
  await queue.pause(1);
  await vi.waitFor(() => expect(task(1).status).toBe('paused'));
  expect(task(1).progress).toBe(latest);
});

it.each(['operation', 'transfer'] as const)(
  'uses handler pause support independently of the %s scheduling category',
  async (category) => {
    const { queue, executions, onSuccess, onFailure, task } = setup(category);
    queue.enqueue({ type: 'transfer', input: 'file' });
    expect(queue.canPause(task(1))).toBe(true);
    await queue.pause(1);
    await vi.waitFor(() => expect(task(1).status).toBe('paused'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    queue.resume(1);
    await vi.waitFor(() => expect(executions).toHaveLength(2));
    executions[1]?.pending.resolve({ status: 'completed', result: undefined });
    await vi.waitFor(() => expect(task(1).status).toBe('completed'));
    expect(onSuccess).toHaveBeenCalledOnce();
  },
);

it('releases capacity after suspension, retains conflicts and resumes at the end of runnable work', async () => {
  const { queue, executions, onSuccess, onFailure, task } = setup();
  for (let index = 0; index < 10; index++)
    queue.enqueue({ type: 'transfer', input: `file-${index}` });
  const previous = executions[0];
  await queue.pause(1);
  await vi.waitFor(() => expect(executions).toHaveLength(9));
  expect(task(1).status).toBe('paused');
  expect(task(9).status).toBe('running');
  expect(queue.enqueue({ type: 'operation', input: 'file-0' })).toBe(false);
  queue.clearFinished();
  expect(queue.store.getState().tasks).toHaveLength(10);
  expect(summarizeTasks(queue.store.getState().tasks)).toEqual({ active: 9, paused: 1, failed: 0 });
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();

  queue.resume(1);
  expect(task(1).status).toBe('queued');
  expect(queue.canPause(task(1))).toBe(false);
  executions[1]?.pending.resolve({ status: 'completed', result: undefined });
  await vi.waitFor(() => expect(executions).toHaveLength(10));
  expect(executions.at(-1)?.input).toBe('file-9');
  executions[2]?.pending.resolve({ status: 'completed', result: undefined });
  await vi.waitFor(() => expect(executions).toHaveLength(11));
  expect(executions.at(-1)?.input).toBe('file-0');
  const progress = task(1).progress;
  previous?.context.reportProgress({
    kind: 'determinate',
    completed: 1,
    total: 999,
    unit: 'bytes',
  });
  previous?.context.reportControls({ cancellable: false, pausable: false });
  expect(task(1).progress).toBe(progress);
  expect(queue.canPause(task(1))).toBe(true);
  for (const execution of executions)
    execution.pending.resolve({ status: 'completed', result: undefined });
  await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(10));
});

it('waits for paused cancellation cleanup before releasing its conflict keys', async () => {
  const { queue, handler, task } = setup();
  queue.enqueue({ type: 'transfer', input: 'file' });
  await queue.pause(1);
  await vi.waitFor(() => expect(task(1).status).toBe('paused'));
  const cleanup = deferred<void>();
  handler.cancel = async () => cleanup.promise;
  const cancel = queue.cancel(1);
  expect(queue.canResume(task(1))).toBe(false);
  expect(queue.enqueue({ type: 'transfer', input: 'file' })).toBe(false);
  cleanup.resolve();
  await cancel;
  expect(task(1).status).toBe('cancelled');
  expect(queue.enqueue({ type: 'transfer', input: 'file' })).toBe(true);
});

it('waits for the execution outcome after a pause request is acknowledged', async () => {
  const { queue, handler, executions, onSuccess, onFailure, task } = setup();
  handler.pause = async () => {};
  for (let index = 0; index < 9; index++)
    queue.enqueue({ type: 'transfer', input: `file-${index}` });
  await queue.pause(1);
  expect(task(1)).toMatchObject({ status: 'running', controlRequest: 'pause' });
  expect(queue.canCancel(task(1))).toBe(false);
  expect(task(9).status).toBe('queued');
  expect(executions).toHaveLength(8);
  expect(queue.enqueue({ type: 'transfer', input: 'file-0' })).toBe(false);
  executions[0]?.pending.resolve({ status: 'paused' });
  await vi.waitFor(() => expect(executions).toHaveLength(9));
  expect(task(1).status).toBe('paused');
  expect(task(9).status).toBe('running');
  expect(onSuccess).not.toHaveBeenCalled();
  expect(onFailure).not.toHaveBeenCalled();
});

it('preserves completion over a late pause and recovers from a rejected pause request', async () => {
  const { queue, handler, executions, onSuccess, task } = setup();
  handler.pause = vi.fn(async () => {
    throw new Error('Already saving');
  });
  queue.enqueue({ type: 'transfer', input: 'file' });
  await queue.pause(1);
  expect(task(1).controlRequest).toBeUndefined();
  expect(queue.canPause(task(1))).toBe(true);
  handler.pause = vi.fn(async () => {
    executions[0]?.pending.resolve({ status: 'completed', result: undefined });
  });
  await queue.pause(1);
  await vi.waitFor(() => expect(task(1).status).toBe('completed'));
  expect(onSuccess).toHaveBeenCalledOnce();
  expect(queue.canPause(task(1))).toBe(false);
});
