import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { presentGroupStatus, type TaskGroupPresenter, type TaskPresenter } from './task-row-model';
import type { TaskGroupViewItem, TaskQueueViewClient, TaskViewItem } from './task-types';
import { TaskGroupPreparationDetails } from './TaskGroupPreparationDetails';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskQueueRow } from './TaskQueueRow';
import classes from './TaskQueueRow.module.css';

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
  return (
    <TaskQueueRow
      status={presentGroupStatus(group)}
      model={{
        ...presentGroup(group),
        compact: true,
        resultMessage: { key: 'tasks:groupSummary', values: { ...group.summary } },
      }}
      action={
        <button
          className={classes.control}
          type="button"
          aria-expanded={opened}
          onClick={() => setOpened(!opened)}
        >
          {t(opened ? 'hideDetails' : 'showDetails')}
        </button>
      }
      summaryNote={
        issueCount > 0 && (
          <>
            {failure && (
              <>
                <span>{t('preparationStatus_failed')}</span>
                {' · '}
              </>
            )}
            {t('preparationIssues', { count: issueCount })}
          </>
        )
      }
      details={
        opened && (
          <>
            <TaskGroupPreparationDetails preparation={group.preparation} />
            <ol className={classes.members} aria-label={t('groupMembers')}>
              {members.map((task) => (
                <TaskQueueItem key={task.id} task={task} queue={queue} presentTask={presentTask} />
              ))}
            </ol>
          </>
        )
      }
    />
  );
}
