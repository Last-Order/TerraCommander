import type { TaskGroupDefinitions } from './task-group-types';
import type { TaskQueue } from './task-queue';
import type { TaskPresenter } from './task-row-model';
import type { QueueTask, TaskDefinitions } from './task-types';
import { TaskQueueRow } from './TaskQueueRow';

export function TaskQueueItem<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>({
  task,
  queue,
  presentTask,
}: {
  task: QueueTask<Definitions>;
  queue: TaskQueue<Definitions, Groups>;
  presentTask: TaskPresenter<Definitions>;
}) {
  return (
    <TaskQueueRow
      status={task.status}
      model={presentTask(task)}
      progress={task.progress}
      failure={task.status === 'failed' ? task.failure : undefined}
      pausing={task.controlRequest === 'pause'}
      pauseSupported={queue.supportsControl(task, 'pause')}
      cancelSupported={queue.supportsControl(task, 'cancel')}
      onPause={
        queue.canPause(task)
          ? () => {
              void queue.pause(task.id);
            }
          : undefined
      }
      onResume={queue.canResume(task) ? () => queue.resume(task.id) : undefined}
      onCancel={
        queue.canCancel(task)
          ? () => {
              void queue.cancel(task.id);
            }
          : undefined
      }
      onRetry={
        queue.canRetry(task)
          ? () => {
              void queue.retry(task.id);
            }
          : undefined
      }
    />
  );
}
