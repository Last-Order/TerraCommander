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
  | { kind: 'indeterminate'; stage?: TaskMessage }
  | {
      kind: 'determinate';
      completed: number;
      total: number;
      unit: 'bytes' | 'items';
      stage?: TaskMessage;
    };

export type TaskDefinitions = Record<string, { input: unknown; result: unknown }>;
export type TaskType<Definitions extends TaskDefinitions> = Extract<keyof Definitions, string>;

export type TaskRequest<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: { type: Kind; input: Definitions[Kind]['input'] };
}[Type];

export type TaskState<Result> =
  | { status: 'queued' | 'running' }
  | { status: 'completed'; result: Result }
  | { status: 'failed'; failure: TaskFailure };

export type QueueTask<
  Definitions extends TaskDefinitions,
  Type extends TaskType<Definitions> = TaskType<Definitions>,
> = {
  [Kind in Type]: {
    id: number;
    request: TaskRequest<Definitions, Kind>;
    progress?: TaskProgress;
  } & TaskState<Definitions[Kind]['result']>;
}[Type];

export type TaskStatus = TaskState<unknown>['status'];

export interface TaskContext {
  reportProgress(progress: TaskProgress): void;
}

export interface TaskHandler<Input, Result> {
  conflictKeys(input: Input): readonly string[];
  execute(input: Input, context: TaskContext): Promise<Result>;
  onSuccess?(input: Input, result: Result): void | Promise<void>;
  toFailure(error: unknown): TaskFailure;
  onFailure?(input: Input, failure: TaskFailure): void | Promise<void>;
}

export type TaskHandlers<Definitions extends TaskDefinitions> = {
  [Type in TaskType<Definitions>]: TaskHandler<
    Definitions[Type]['input'],
    Definitions[Type]['result']
  >;
};
