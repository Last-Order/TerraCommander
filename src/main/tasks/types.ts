import type {
  TaskControls,
  TaskFailure,
  TaskGroupOutcome,
  TaskGroupPreparation,
  TaskGroupState,
  TaskGroupSummary,
  TaskMessage,
  TaskPreparationIssue,
  TaskProgress,
  TaskStatus,
} from '@shared/tasks';

export type {
  TaskControls,
  TaskFailure,
  TaskGroupOutcome,
  TaskGroupPreparation,
  TaskGroupState,
  TaskGroupSummary,
  TaskMessage,
  TaskPreparationIssue,
  TaskProgress,
  TaskStatus,
};

export type TaskDefinitions = Record<string, { input: unknown; result: unknown }>;
export type TaskType<Definitions extends TaskDefinitions> = Extract<keyof Definitions, string>;

export type TaskRequest<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: {
    type: Kind;
    input: Definitions[Kind]['input'];
    resources?: readonly string[] | undefined;
  };
}[Type];

export type TaskState<Result> =
  | { status: 'queued'; controlRequest?: 'cancel' | undefined; controls?: never }
  | {
      status: 'paused';
      controlRequest?: 'cancel' | undefined;
      controls?: never;
      failure?: TaskFailure | undefined;
    }
  | {
      status: 'running';
      controlRequest?: 'pause' | 'cancel' | undefined;
      controls: TaskControls;
    }
  | ({ controlRequest?: never; controls?: never } & (
      | { status: 'completed'; result: Result }
      | { status: 'cancelled' | 'skipped' }
      | { status: 'failed'; failure: TaskFailure }
    ));

export type TaskExecutionOutcome<Result> =
  | { status: 'completed'; result: Result }
  | { status: 'failed'; failure: TaskFailure }
  | { status: 'paused'; failure?: TaskFailure | undefined }
  | { status: 'cancelled' | 'skipped' };

export type QueueTask<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: {
    id: number;
    request: TaskRequest<Definitions, Kind>;
    progress?: TaskProgress | undefined;
    groupId?: number | undefined;
    memberKey?: string | undefined;
  } & TaskState<Definitions[Kind]['result']>;
}[Type];

export interface TaskContext {
  reportProgress(progress: TaskProgress): void;
  reportControls(controls: TaskControls): void;
  taskId: number;
  groupId?: number | undefined;
  signal: AbortSignal;
}

export interface TaskHandler<Input, Result, Category extends string = string> {
  readonly category: Category;
  conflictKeys?(input: Input): readonly string[];
  execute(input: Input, context: TaskContext): Promise<TaskExecutionOutcome<Result>>;
  cancel?(input: Input): void | Promise<void>;
  pause?(input: Input): void | Promise<void>;
  onSuccess?(input: Input, result: Result): void | Promise<void>;
  toFailure(error: unknown): TaskFailure;
  onFailure?(input: Input, failure: TaskFailure): void | Promise<void>;
  retry?(input: Input): Promise<void>;
  canRetry?(input: Input): boolean;
  release?(input: Input): Promise<void>;
}

export type TaskHandlers<Definitions extends TaskDefinitions, Category extends string = string> = {
  [Type in TaskType<Definitions>]: TaskHandler<
    Definitions[Type]['input'],
    Definitions[Type]['result'],
    Category
  >;
};

export interface TaskQueueOptions<Category extends string = string> {
  concurrencyLimits: Readonly<Record<Category, number>>;
}

export type TaskGroupDefinitions = Record<string, { input: unknown }>;

export type TaskGroupRequest<Definitions extends TaskGroupDefinitions = TaskGroupDefinitions> = {
  [Kind in Extract<keyof Definitions, string>]: {
    kind: Kind;
    input: Definitions[Kind]['input'];
    resources?: readonly string[] | undefined;
  };
}[Extract<keyof Definitions, string>];

export interface TaskGroup<Definitions extends TaskGroupDefinitions = TaskGroupDefinitions> {
  id: number;
  request: TaskGroupRequest<Definitions>;
  sealed: boolean;
  state: TaskGroupState;
  summary: TaskGroupSummary;
  preparation: TaskGroupPreparation;
}

export interface TaskGroupPreparationContext<Definitions extends TaskDefinitions> {
  groupId: number;
  signal: AbortSignal;
  enqueue(request: TaskRequest<Definitions>, memberKey?: string): Promise<boolean>;
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
  groupId?: number | undefined;
  memberKey?: string | undefined;
}

export interface TaskQueueSnapshot<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions = TaskGroupDefinitions,
> {
  tasks: readonly QueueTask<Definitions>[];
  groups: readonly TaskGroup<Groups>[];
}

export type TaskQueueChange = { kind: 'snapshot' } | { kind: 'task-progress'; taskId: number };
