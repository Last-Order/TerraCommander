import { describe, expect, it, vi } from 'vitest';
import { TaskConflictLedger } from './conflict-ledger';
import { TaskQueue } from './task-queue';

describe('TaskConflictLedger shared/exclusive locks and reservations', () => {
  it('allows shared+shared concurrency while blocking exclusive overlaps', () => {
    const ledger = new TaskConflictLedger();

    // Group 1 transfers /A (exclusive /A, shared /)
    ledger.reserveGroup(1, { exclusive: ['/A'], shared: ['/'] });

    // Group 2 transfers /B (exclusive /B, shared /) -> no conflict with Group 1!
    expect(ledger.hasConflicts({ exclusive: ['/B'], shared: ['/'] })).toBe(false);
    ledger.reserveGroup(2, { exclusive: ['/B'], shared: ['/'] });

    // Sibling child tasks inside Group 1 (/A/f1, /A/f2) run in parallel!
    expect(
      ledger.hasConflicts({ exclusive: ['/A/f1'], shared: ['/A', '/'] }, { ownGroup: 1 }),
    ).toBe(false);
    ledger.reserveTask(10, { exclusive: ['/A/f1'], shared: ['/A', '/'] });
    expect(
      ledger.hasConflicts({ exclusive: ['/A/f2'], shared: ['/A', '/'] }, { ownGroup: 1 }),
    ).toBe(false);
    ledger.reserveTask(11, { exclusive: ['/A/f2'], shared: ['/A', '/'] });

    // External task targeting /A/sub/x (shared /A, /) is blocked by Group 1's exclusive /A.
    expect(ledger.hasConflicts({ exclusive: ['/A/sub/x'], shared: ['/A', '/'] })).toBe(true);

    // External task trying to delete / (exclusive /) is blocked by shared / on Groups 1 & 2.
    expect(ledger.hasConflicts({ exclusive: ['/'] })).toBe(true);

    ledger.releaseTask(10);
    ledger.releaseTask(11);
    ledger.releaseGroup(1);
    ledger.releaseGroup(2);
    expect(ledger.hasConflicts({ exclusive: ['/'] })).toBe(false);
  });

  it('merges pending reservation locks into a task and releases unused reservations', () => {
    const ledger = new TaskConflictLedger();

    expect(ledger.reservePending('r1', { exclusive: ['/target'], shared: ['/'] })).toBe(true);
    // Duplicate conflicting reservation is rejected.
    expect(ledger.reservePending('r2', { exclusive: ['/target'] })).toBe(false);
    // Sibling reservation succeeds.
    expect(ledger.reservePending('r2', { exclusive: ['/other'], shared: ['/'] })).toBe(true);

    // Atomic transfer from reservation r1 to task 100 preserves lock with zero gap.
    expect(ledger.transferPendingToTask('r1', 100, { exclusive: ['/source'] })).toBe(true);
    expect(ledger.getPendingLocks('r1')).toBeUndefined();
    expect(ledger.hasConflicts({ exclusive: ['/target'] })).toBe(true);
    expect(ledger.hasConflicts({ exclusive: ['/source'] })).toBe(true);

    // Releasing r2 frees /other immediately.
    ledger.releasePending('r2');
    expect(ledger.hasConflicts({ exclusive: ['/other'] })).toBe(false);
  });
});

describe('TaskQueue reservations and group finalization', () => {
  it('keeps reservation locks held by the task until it completes', async () => {
    let resolveWork!: () => void;
    const workStarted = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    let finishWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      finishWork = resolve;
    });

    const queue = new TaskQueue<
      { job: { input: string; result: void } },
      Record<string, never>,
      'op'
    >(
      {
        job: {
          category: 'op',
          execute: async () => {
            resolveWork();
            await workGate;
            return { status: 'completed', result: undefined };
          },
          toFailure: () => ({ code: 'unknown', message: { key: 'err' } }),
        },
      },
      { concurrencyLimits: { op: 4 } },
    );

    const reservationId = queue.reserve({ exclusive: ['slot:/a'], shared: ['slot:/'] });
    expect(reservationId).toBeDefined();
    // Another conflicting enqueue fails while reserved.
    expect(queue.enqueue({ type: 'job', input: 'conflict', resources: ['slot:/a'] })).toBe(false);

    // Atomic handoff succeeds.
    expect(queue.enqueue({ type: 'job', input: 'winner' }, { reservationId })).toBe(true);
    await workStarted;

    // Lock remains held while task runs.
    expect(queue.reserve({ exclusive: ['slot:/a'] })).toBeUndefined();

    finishWork();
    await vi.waitFor(() => {
      expect(queue.store.getState().tasks[0]?.status).toBe('completed');
    });

    // Lock released after completion.
    const nextRes = queue.reserve({ exclusive: ['slot:/a'] });
    expect(nextRes).toBeDefined();
    queue.releaseReservation(nextRes!);
    await queue.dispose();
  });

  it('runs group finalize hook to enqueue cleanup tasks and supports retrying failed cleanup', async () => {
    let failCleanup = true;
    const queue = new TaskQueue<
      {
        copy: { input: string; result: void };
        cleanup: { input: string; result: void };
      },
      { move: { input: string } },
      'op'
    >(
      {
        copy: {
          category: 'op',
          execute: async () => ({ status: 'completed', result: undefined }),
          toFailure: () => ({ code: 'unknown', message: { key: 'err' } }),
        },
        cleanup: {
          category: 'op',
          execute: async () => {
            if (failCleanup) {
              return {
                status: 'failed',
                failure: { code: 'PreconditionFailed', message: { key: 'notEmpty' } },
              };
            }
            return { status: 'completed', result: undefined };
          },
          retry: async () => {},
          toFailure: () => ({ code: 'unknown', message: { key: 'err' } }),
        },
      },
      { concurrencyLimits: { op: 4 } },
    );

    const groupId = queue.createGroup(
      { kind: 'move', input: 'dirA', resources: ['src:dirA'] },
      {
        finalize: (ctx) => {
          ctx.enqueue({ type: 'cleanup', input: 'dirA' }, 'cleanup:dirA');
        },
      },
    );
    expect(groupId).toBeDefined();
    expect(queue.enqueue({ type: 'copy', input: 'file1' }, { groupId })).toBe(true);
    queue.sealGroup(groupId!);

    await vi.waitFor(() => {
      const group = queue.store.getState().groups[0];
      expect(group?.state).toEqual({ phase: 'settled', outcome: 'partial' });
    });

    const cleanupTask = queue.store.getState().tasks.find((t) => t.request.type === 'cleanup');
    expect(cleanupTask?.status).toBe('failed');

    // Retrying only re-runs cleanup and transitions group to completed.
    failCleanup = false;
    await queue.retry(cleanupTask!.id);
    await vi.waitFor(() => {
      const group = queue.store.getState().groups[0];
      expect(group?.state).toEqual({ phase: 'settled', outcome: 'completed' });
    });
    expect(queue.store.getState().tasks.filter((t) => t.request.type === 'cleanup')).toHaveLength(
      1,
    );
    await queue.dispose();
  });
});
