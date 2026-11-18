import { presentGroupStatus } from './task-row-model';
import type { TaskGroupDefinitions } from './task-group-types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { TaskQueue } from './task-queue';
import type { TaskGroup } from './task-group-types';
import type { TaskGroupPresenter, TaskPresenter } from './task-row-model';
import type { TaskDefinitions } from './task-types';
import { TaskQueueRow } from './TaskQueueRow';
import { TaskQueueItem } from './TaskQueueItem';
import { TaskGroupPreparationDetails } from './TaskGroupPreparationDetails';
import classes from './TaskQueueRow.module.css';

export function TaskQueueGroupRow<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>({
  group,
  queue,
  presentTask,
  presentGroup,
}: {
  group: TaskGroup<Groups>;
  queue: TaskQueue<Definitions, Groups>;
  presentTask: TaskPresenter<Definitions>;
  presentGroup: TaskGroupPresenter<Groups>;
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
