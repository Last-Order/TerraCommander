import { Check, CircleAlert, Clock3, LoaderCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { useTaskQueue } from './task-queue-context';
import classes from './TaskQueuePanel.module.css';

interface TaskQueuePanelProps {
  id: string;
  opened: boolean;
  onClose: () => void;
}

const statusIcons = {
  queued: Clock3,
  running: LoaderCircle,
  completed: Check,
  failed: CircleAlert,
};

export function TaskQueuePanel({ id, opened, onClose }: TaskQueuePanelProps) {
  const { t } = useTranslation(['storage', 'errors']);
  const queue = useTaskQueue();
  const tasks = useStore(queue.store, (state) => state.tasks);
  const hasFinished = tasks.some(({ status }) => status === 'completed' || status === 'failed');

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
            {tasks.map((task) => {
              const Icon = statusIcons[task.status];
              return (
                <li key={task.id} className={classes.task} data-status={task.status}>
                  <Icon
                    className={classes.statusIcon}
                    size={16}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <div className={classes.description}>
                    <div className={classes.operation}>
                      <span className={classes.type}>{t('renameEntry')}</span>
                      <span className={classes.name} title={task.request.entry.name}>
                        {task.request.entry.name}
                      </span>
                      <span className={classes.arrow} aria-hidden="true">
                        →
                      </span>
                      <span className={classes.name} title={task.request.name}>
                        {task.request.name}
                      </span>
                    </div>
                    <div className={classes.path} title={task.request.directoryPath}>
                      {task.request.directoryPath}
                    </div>
                    {task.status === 'failed' && (
                      <p className={classes.error}>
                        {task.error === 'InvalidArgument'
                          ? t('invalidEntryName')
                          : t(`errors:${task.error}`)}
                      </p>
                    )}
                  </div>
                  <span className={classes.status}>{t(`taskStatus_${task.status}`)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
