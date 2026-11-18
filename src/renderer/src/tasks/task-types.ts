import type { en } from '../i18n/en';

type MessageKey = {
  [Namespace in keyof typeof en]: `${Namespace}:${Extract<keyof (typeof en)[Namespace], string>}`;
}[keyof typeof en];

export interface TaskMessage {
  key: MessageKey;
  values?: Readonly<Record<string, string | number>>;
}

export interface TaskFailure {
  code: string;
  message: TaskMessage;
}

export type TaskProgress =
  | {
      kind: 'indeterminate';
      stage?: TaskMessage;
      completedBytes?: number;
      bytesPerSecond?: number;
      summary?: TaskMessage;
    }
  | {
      kind: 'determinate';
      completed: number;
      total: number;
      unit: 'bytes' | 'items';
      stage?: TaskMessage;
      bytesPerSecond?: number;
      summary?: TaskMessage;
    };

export type TaskDefinitions = Record<string, { input: unknown; result: unknown }>;
export type TaskType<Definitions extends TaskDefinitions> = Extract<keyof Definitions, string>;
export type TaskCategory = 'operation' | 'transfer';

export type TaskRequest<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: { type: Kind; input: Definitions[Kind]['input'] };
}[Type];

export interface TaskControls {
  cancellable: boolean;
  pausable: boolean;
}

export type TaskState<Result> =
  | { status: 'queued' | 'paused'; controlRequest?: 'cancel' | undefined; controls?: never }
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
  | { status: 'paused' }
  | { status: 'cancelled' | 'skipped' };

export type QueueTask<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: {
    id: number;
    request: TaskRequest<Definitions, Kind>;
    progress?: TaskProgress;
    groupId?: number;
    memberKey?: string;
  } & TaskState<Definitions[Kind]['result']>;
}[Type];

export type TaskStatus = TaskState<unknown>['status'];

export interface TaskContext {
  reportProgress(progress: TaskProgress): void;
  reportControls(controls: TaskControls): void;
  taskId: number;
  groupId?: number;
  signal: AbortSignal;
}

export interface TaskHandler<Input, Result> {
  readonly category: TaskCategory;
  conflictKeys(input: Input): readonly string[];
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

export type TaskHandlers<Definitions extends TaskDefinitions> = {
  [Type in TaskType<Definitions>]: TaskHandler<
    Definitions[Type]['input'],
    Definitions[Type]['result']
  >;
};
