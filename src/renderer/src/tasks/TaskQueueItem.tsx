import { isFinishedTask } from '@shared/task-selectors';
import type { TaskPresenter } from './task-row-model';
import type { TaskGroupViewItem, TaskQueueViewClient, TaskViewItem } from './task-types';
import { TaskQueueRow } from './TaskQueueRow';

export function TaskQueueItem<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem>({
  task,
  queue,
  presentTask,
}: {
  task: TTask;
  queue: TaskQueueViewClient<TTask, TGroup>;
  presentTask: TaskPresenter<TTask>;
}) {
  return (
    <TaskQueueRow
      status={task.status}
      model={presentTask(task)}
      progress={task.progress}
      failure={task.status === 'failed' || task.status === 'paused' ? task.failure : undefined}
      pausing={task.controlRequest === 'pause'}
      pauseSupported={task.controls.supportsPause && !isFinishedTask(task)}
      cancelSupported={task.controls.supportsCancel && !isFinishedTask(task)}
      onPause={
        task.controls.canPause
          ? () => {
              void queue.pause(task.id);
            }
          : undefined
      }
      onResume={
        task.controls.canResume
          ? () => {
              void queue.resume(task.id);
            }
          : undefined
      }
      onCancel={
        task.controls.canCancel
          ? () => {
              void queue.cancel(task.id);
            }
          : undefined
      }
      onRetry={
        task.controls.canRetry
          ? () => {
              void queue.retry(task.id);
            }
          : undefined
      }
    />
  );
}
