import { ListTodo } from 'lucide-react';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { TaskQueue } from './task-queue';
import { summarizeTasks } from './task-selectors';
import type { TaskDefinitions } from './task-types';
import classes from './WorkspaceStatusBar.module.css';

interface WorkspaceStatusBarProps<Definitions extends TaskDefinitions> {
  queue: TaskQueue<Definitions>;
  panelId: string;
  opened: boolean;
  onToggle: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}

export function WorkspaceStatusBar<Definitions extends TaskDefinitions>({
  queue,
  panelId,
  opened,
  onToggle,
  buttonRef,
}: WorkspaceStatusBarProps<Definitions>) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const { active, failed } = summarizeTasks(tasks);

  return (
    <footer className={classes.bar} aria-label={t('statusBar')}>
      <span className={classes.summary} aria-live="polite">
        {active > 0 ? t('activeTasks', { count: active }) : t('tasksIdle')}
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
        {active > 0 && (
          <span className={classes.count} aria-hidden="true">
            {active}
          </span>
        )}
        {failed > 0 && (
          <span className={classes.failed}>{t('failedTasks', { count: failed })}</span>
        )}
      </button>
    </footer>
  );
}
