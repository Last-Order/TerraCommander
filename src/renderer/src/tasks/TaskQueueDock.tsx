import { useId, useRef, useState, type ReactNode } from 'react';
import { TaskQueuePanel } from './TaskQueuePanel';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import classes from './TaskQueueDock.module.css';
import type { TaskQueue } from './task-queue';
import type { TaskPresenter } from './task-row-model';
import type { TaskDefinitions } from './task-types';

export function TaskQueueDock<Definitions extends TaskDefinitions>({
  children,
  queue,
  presentTask,
}: {
  children: ReactNode;
  queue: TaskQueue<Definitions>;
  presentTask: TaskPresenter<Definitions>;
}) {
  const [opened, setOpened] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement | null>(null);

  const close = () => {
    setOpened(false);
    button.current?.focus();
  };

  return (
    <>
      <div className={classes.content}>
        {children}
        <TaskQueuePanel
          id={panelId}
          opened={opened}
          onClose={close}
          queue={queue}
          presentTask={presentTask}
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
