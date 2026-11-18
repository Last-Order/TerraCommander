import type { TaskDefinitions, TaskFailure, TaskProgress, TaskRequest } from './task-types';

export type TaskGroupDefinitions = Record<string, { input: unknown }>;

export type TaskGroupRequest<Definitions extends TaskGroupDefinitions = TaskGroupDefinitions> = {
  [Kind in Extract<keyof Definitions, string>]: {
    kind: Kind;
    input: Definitions[Kind]['input'];
    resources?: readonly string[];
  };
}[Extract<keyof Definitions, string>];

export type TaskGroupOutcome = 'completed' | 'partial' | 'failed' | 'cancelled';
export type TaskGroupState =
  | { phase: 'active' | 'settling'; outcome?: never }
  | { phase: 'settled'; outcome: TaskGroupOutcome };

export interface TaskGroupSummary {
  total: number;
  queued: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export interface TaskGroup<Definitions extends TaskGroupDefinitions = TaskGroupDefinitions> {
  id: number;
  request: TaskGroupRequest<Definitions>;
  sealed: boolean;
  state: TaskGroupState;
  summary: TaskGroupSummary;
  progress: TaskProgress;
  preparation: TaskGroupPreparation;
}

export interface TaskPreparationIssue {
  label: string;
  failure: TaskFailure;
}

export interface TaskGroupPreparation {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: TaskProgress;
  issues: readonly TaskPreparationIssue[];
  failure?: TaskFailure;
}

export interface TaskGroupPreparationContext<Definitions extends TaskDefinitions> {
  groupId: number;
  signal: AbortSignal;
  enqueue(request: TaskRequest<Definitions>, memberKey?: string): Promise<boolean>;
  reportProgress(progress: TaskProgress): void;
  reportIssue(issue: TaskPreparationIssue): void;
}

/** Executable hooks and cancellation stay outside observable snapshots. */
export interface TaskGroupHooks<Definitions extends TaskDefinitions = TaskDefinitions> {
  prepare?(context: TaskGroupPreparationContext<Definitions>): Promise<void>;
  toFailure?(error: unknown): TaskFailure;
  onPreparationFailure?(failure: TaskFailure): void | Promise<void>;
  onSettled?(): Promise<void>;
  release?(): Promise<void>;
}

export interface TaskMembership {
  groupId?: number;
  memberKey?: string;
}
