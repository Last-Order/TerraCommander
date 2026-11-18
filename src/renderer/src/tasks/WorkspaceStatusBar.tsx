import type { TaskGroupDefinitions } from './task-group-types';
import { ListTodo } from 'lucide-react';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { TaskQueue } from './task-queue';
import { summarizeTasks, topLevelEntries } from './task-selectors';
import type { TaskDefinitions } from './task-types';
import classes from './WorkspaceStatusBar.module.css';

interface WorkspaceStatusBarProps<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
> {
  queue: TaskQueue<Definitions, Groups>;
  panelId: string;
  opened: boolean;
  onToggle: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}

export function WorkspaceStatusBar<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>({ queue, panelId, opened, onToggle, buttonRef }: WorkspaceStatusBarProps<Definitions, Groups>) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const { active, failed, paused } = summarizeTasks(topLevelEntries(tasks, groups));

  return (
    <footer className={classes.bar} aria-label={t('statusBar')}>
      <span className={classes.summary} aria-live="polite">
        {active > 0
          ? t('activeTasks', { count: active })
          : paused > 0
            ? t('pausedTasks', { count: paused })
            : t('tasksIdle')}
        {active > 0 && paused > 0 && <span> · {t('pausedTasks', { count: paused })}</span>}
      </span>
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
