import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { TaskQueue } from './task-queue';
import type { TaskPresenter } from './task-row-model';
import { isFinishedTask } from './task-selectors';
import type { TaskDefinitions } from './task-types';
import { TaskQueueRow } from './TaskQueueRow';
import classes from './TaskQueuePanel.module.css';

interface TaskQueuePanelProps<Definitions extends TaskDefinitions> {
  id: string;
  opened: boolean;
  onClose: () => void;
  queue: TaskQueue<Definitions>;
  presentTask: TaskPresenter<Definitions>;
}

export function TaskQueuePanel<Definitions extends TaskDefinitions>({
  id,
  opened,
  onClose,
  queue,
  presentTask,
}: TaskQueuePanelProps<Definitions>) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const hasFinished = tasks.some(isFinishedTask);

  return (
    <section id={id} className={classes.panel} hidden={!opened} aria-label={t('taskQueue')}>
      <header className={classes.header}>
        <h2>{t('taskQueue')}</h2>
        <span className={classes.total}>{tasks.length}</span>
        <div className={classes.actions}>
          <button type="button" disabled={!hasFinished} onClick={() => queue.clearFinished()}>
            {t('clearFinishedTasks')}
          </button>
          <button type="button" aria-label={t('closeTaskQueue')} onClick={onClose}>
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className={classes.contents}>
        {tasks.length === 0 ? (
          <p className={classes.empty}>{t('emptyTaskQueue')}</p>
        ) : (
          <ol className={classes.tasks} aria-label={t('taskQueue')}>
            {tasks.map((task) => (
              <TaskQueueRow
                key={task.id}
                status={task.status}
                model={presentTask(task)}
                progress={task.progress}
                failure={task.status === 'failed' ? task.failure : undefined}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
