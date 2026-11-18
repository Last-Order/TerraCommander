import type { TaskGroupDefinitions } from './task-group-types';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { TaskQueue } from './task-queue';
import type { TaskGroupPresenter, TaskPresenter } from './task-row-model';
import { isFinishedGroup, isFinishedTask, topLevelEntries } from './task-selectors';
import type { TaskDefinitions } from './task-types';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskQueueGroupRow } from './TaskQueueGroupRow';
import classes from './TaskQueuePanel.module.css';

interface TaskQueuePanelProps<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
> {
  id: string;
  opened: boolean;
  onClose: () => void;
  queue: TaskQueue<Definitions, Groups>;
  presentTask: TaskPresenter<Definitions>;
  presentGroup: TaskGroupPresenter<Groups>;
}

export function TaskQueuePanel<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>({
  id,
  opened,
  onClose,
  queue,
  presentTask,
  presentGroup,
}: TaskQueuePanelProps<Definitions, Groups>) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const entries = topLevelEntries(tasks, groups);
  const hasFinished = entries.some((entry) =>
    entry.kind === 'group' ? isFinishedGroup(entry.group) : isFinishedTask(entry.task),
  );

  return (
    <section id={id} className={classes.panel} hidden={!opened} aria-label={t('taskQueue')}>
      <header className={classes.header}>
        <h2>{t('taskQueue')}</h2>
        <span className={classes.total}>{entries.length}</span>
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
        {entries.length === 0 ? (
          <p className={classes.empty}>{t('emptyTaskQueue')}</p>
        ) : (
          <ol className={classes.tasks} aria-label={t('taskQueue')}>
            {entries.map((entry) =>
              entry.kind === 'task' ? (
                <TaskQueueItem
                  key={entry.id}
                  task={entry.task}
                  queue={queue}
                  presentTask={presentTask}
                />
              ) : (
                <TaskQueueGroupRow
                  key={entry.id}
                  group={entry.group}
                  presentGroup={presentGroup}
                  queue={queue}
                  presentTask={presentTask}
                />
              ),
            )}
          </ol>
        )}
      </div>
    </section>
  );
}
