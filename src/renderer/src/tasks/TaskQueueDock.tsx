import { useId, useRef, useState, type ReactNode } from 'react';
import { TaskQueuePanel } from './TaskQueuePanel';
import { WorkspaceStatusBar } from './WorkspaceStatusBar';
import classes from './TaskQueueDock.module.css';

export function TaskQueueDock({ children }: { children: ReactNode }) {
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
        <TaskQueuePanel id={panelId} opened={opened} onClose={close} />
      </div>
      <WorkspaceStatusBar
        panelId={panelId}
        opened={opened}
        onToggle={() => setOpened((previous) => !previous)}
        buttonRef={button}
      />
    </>
  );
}
