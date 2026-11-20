import { expectTypeOf } from 'vitest';
import type { TaskControls, TaskGroupState, TaskState } from './types';

// Control requests are valid only in specific lifecycle states.
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

// Aggregate outcomes belong to settled groups.
expectTypeOf<{ status: 'partial'; result: void }>().not.toExtend<TaskState<void>>();
expectTypeOf<{ phase: 'settled'; outcome: 'partial' }>().toExtend<TaskGroupState>();
expectTypeOf<{ phase: 'active'; outcome: 'partial' }>().not.toExtend<TaskGroupState>();
expectTypeOf<{ phase: 'settled' }>().not.toExtend<TaskGroupState>();
