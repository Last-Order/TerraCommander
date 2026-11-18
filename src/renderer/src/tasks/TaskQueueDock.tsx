import type { TaskGroupDefinitions } from './task-group-types';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { TaskQueuePanel } from './TaskQueuePanel';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import classes from './TaskQueueDock.module.css';
import type { TaskQueue } from './task-queue';
import type { TaskGroupPresenter, TaskPresenter } from './task-row-model';
import type { TaskDefinitions } from './task-types';

export function TaskQueueDock<
  Definitions extends TaskDefinitions,
  Groups extends TaskGroupDefinitions,
>({
  children,
  queue,
  presentTask,
  presentGroup,
}: {
  children: ReactNode;
  queue: TaskQueue<Definitions, Groups>;
  presentTask: TaskPresenter<Definitions>;
  presentGroup: TaskGroupPresenter<Groups>;
}) {
  const [opened, setOpened] = useState(false);
  const [height, setHeight] = useState<number>();
  const panelId = useId();
  const button = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () =>
      queue.store.subscribe((state, previous) => {
        if (
          state.groups.length > previous.groups.length ||
          state.tasks.filter((task) => task.groupId === undefined).length >
            previous.tasks.filter((task) => task.groupId === undefined).length
        )
          setOpened(true);
      }),
    [queue],
  );

  const close = () => {
    setOpened(false);
    button.current?.focus();
  };

  return (
    <>
      <div
        className={classes.content}
        style={
          {
            '--task-panel-resized-height': height === undefined ? undefined : `${height}px`,
          } as CSSProperties
        }
      >
        {children}
        <TaskQueuePanel
          id={panelId}
          opened={opened}
          onClose={close}
          onResize={setHeight}
          queue={queue}
          presentTask={presentTask}
          presentGroup={presentGroup}
        />
      </div>
      <WorkspaceStatusBar
        queue={queue}
        panelId={panelId}
        opened={opened}
        onToggle={() => setOpened((previous) => !previous)}
        buttonRef={button}
      />
    </>
  );
}
