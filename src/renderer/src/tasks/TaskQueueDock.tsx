import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { TaskDisplayContext, type TaskMessageTranslator } from './task-display-context';
import type { TaskGroupPresenter, TaskPresenter } from './task-row-model';
import type { TaskGroupViewItem, TaskQueueViewClient, TaskViewItem } from './task-types';
import { TaskQueuePanel } from './TaskQueuePanel';
import classes from './TaskQueueDock.module.css';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';

export function TaskQueueDock<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem>({
  children,
  queue,
  presentTask,
  presentGroup,
  translateMessage,
}: {
  children: ReactNode;
  queue: TaskQueueViewClient<TTask, TGroup>;
  presentTask: TaskPresenter<TTask>;
  presentGroup: TaskGroupPresenter<TGroup>;
  translateMessage?: TaskMessageTranslator | undefined;
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
    <TaskDisplayContext.Provider value={translateMessage ?? null}>
      <div
        className={classes.content}
        style={
          {
            '--task-panel-resized-height': height === undefined ? undefined : `${height}px`,
            '--task-panel-visible-height': opened ? 'var(--task-panel-height)' : '0px',
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
    </TaskDisplayContext.Provider>
  );
}
