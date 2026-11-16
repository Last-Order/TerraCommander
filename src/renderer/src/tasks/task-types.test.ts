import { expectTypeOf, it } from 'vitest';
import type { TaskControls, TaskState } from './task-types';

it('restricts control requests to valid lifecycle states', () => {
  expectTypeOf<{
    status: 'running';
    controls: TaskControls;
    controlRequest: 'pause';
  }>().toExtend<TaskState<void>>();
  expectTypeOf<{ status: 'paused'; controlRequest: 'cancel' }>().toExtend<TaskState<void>>();
  expectTypeOf<{ status: 'queued'; controlRequest: 'pause' }>().not.toExtend<TaskState<void>>();
  expectTypeOf<{ status: 'paused'; controlRequest: 'pause' }>().not.toExtend<TaskState<void>>();
  expectTypeOf<{
    status: 'completed';
    result: void;
    controlRequest: 'cancel';
  }>().not.toExtend<TaskState<void>>();
  expectTypeOf<{ status: 'cancelled'; controls: TaskControls }>().not.toExtend<TaskState<void>>();
});
