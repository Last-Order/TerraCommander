import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { presentGroupStatus, type TaskGroupPresenter, type TaskPresenter } from './task-row-model';
import type {
  TaskGroupSummary,
  TaskGroupViewItem,
  TaskQueueViewClient,
  TaskViewItem,
} from './task-types';
import { TaskGroupPreparationDetails } from './TaskGroupPreparationDetails';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskQueueRow } from './TaskQueueRow';
import classes from './TaskQueueRow.module.css';

function GroupCounts({ summary }: { summary: TaskGroupSummary }) {
  const { t } = useTranslation('tasks');
  return (
    <>
      <span>{t('groupCompleted', { completed: summary.completed, total: summary.total })}</span>
      {summary.failed > 0 && (
        <span className={classes.error}>{t('groupFailed', { count: summary.failed })}</span>
      )}
      {summary.skipped > 0 && <span>{t('groupSkipped', { count: summary.skipped })}</span>}
      {summary.cancelled > 0 && <span>{t('groupCancelled', { count: summary.cancelled })}</span>}
    </>
  );
}

export function TaskQueueGroupRow<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem>({
  group,
  queue,
  presentTask,
  presentGroup,
}: {
  group: TGroup;
  queue: TaskQueueViewClient<TTask, TGroup>;
  presentTask: TaskPresenter<TTask>;
  presentGroup: TaskGroupPresenter<TGroup>;
}) {
  const { t } = useTranslation('tasks');
  const tasks = useStore(queue.store, (state) => state.tasks);
  const members = tasks.filter((task) => task.groupId === group.id);
  const { failure, issues } = group.preparation;
  const issueCount = issues.length + (failure ? 1 : 0);
  const [opened, setOpened] = useState(false);
  // Members share the group's location, so their own location line only repeats it.
  const presentMember: TaskPresenter<TTask> = (task) => {
    const { summary: _summary, ...model } = presentTask(task);
    return model;
  };
  const toggle = () => setOpened((previous) => !previous);
  return (
    <TaskQueueRow
      status={presentGroupStatus(group)}
      model={presentGroup(group)}
      aside={<GroupCounts summary={group.summary} />}
      expanded={opened}
      onToggle={toggle}
      summaryNote={
        issueCount > 0 && (
          <span className={classes.error}>
            {failure && (
              <>
                {t('preparationStatusFailed')}
                {' · '}
              </>
            )}
            {t('preparationIssues', { count: issueCount })}
          </span>
        )
      }
      details={
        opened && (
          <>
            <TaskGroupPreparationDetails preparation={group.preparation} />
            <ol className={classes.members} aria-label={t('groupMembers')}>
              {members.map((task) => (
                <TaskQueueItem
                  key={task.id}
                  task={task}
                  queue={queue}
                  presentTask={presentMember}
                />
              ))}
            </ol>
          </>
        )
      }
    />
  );
}
