import { ListTodo } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { summarizeTasks, topLevelEntries } from '@shared/task-selectors';
import type { TaskGroupViewItem, TaskQueueViewClient, TaskViewItem } from './task-types';
import classes from './WorkspaceStatusBar.module.css';

interface WorkspaceStatusBarProps<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem> {
  queue: TaskQueueViewClient<TTask, TGroup>;
  panelId: string;
  opened: boolean;
  onToggle: () => void;
  buttonRef: Ref<HTMLButtonElement>;
  status?: ReactNode;
}

export function WorkspaceStatusBar<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem>({
  queue,
  panelId,
  opened,
  onToggle,
  buttonRef,
  status,
}: WorkspaceStatusBarProps<TTask, TGroup>) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const { active, failed, paused } = summarizeTasks(topLevelEntries(tasks, groups));
  let summary: string = t('tasksIdle');
  if (active > 0) summary = t('activeTasks', { count: active });
  else if (paused > 0) summary = t('pausedTasks', { count: paused });

  return (
    <footer className={classes.bar} aria-label={t('statusBar')}>
      <div className={classes.leading}>
        <span className={classes.summary} aria-live="polite">
          {summary}
          {active > 0 && paused > 0 && <span> · {t('pausedTasks', { count: paused })}</span>}
        </span>
        {status && <div className={classes.status}>{status}</div>}
      </div>
      <button
        type="button"
        ref={buttonRef}
        className={classes.toggle}
        aria-label={t('taskQueue')}
        aria-expanded={opened}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <ListTodo size={14} strokeWidth={1.5} aria-hidden="true" />
        {t('taskQueue')}
        {active + paused > 0 && (
          <span className={classes.count} aria-hidden="true">
            {active + paused}
          </span>
        )}
        {failed > 0 && (
          <span className={classes.failed}>{t('failedTasks', { count: failed })}</span>
        )}
      </button>
    </footer>
  );
}
