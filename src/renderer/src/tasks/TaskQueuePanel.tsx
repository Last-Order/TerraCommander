import { X } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import { isFinishedGroup, isFinishedTask, topLevelEntries } from '@shared/task-selectors';
import type { TaskGroupPresenter, TaskPresenter } from './task-row-model';
import type { TaskGroupViewItem, TaskQueueViewClient, TaskViewItem } from './task-types';
import { TaskQueueGroupRow } from './TaskQueueGroupRow';
import { TaskQueueItem } from './TaskQueueItem';
import classes from './TaskQueuePanel.module.css';

interface TaskQueuePanelProps<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem> {
  id: string;
  opened: boolean;
  onClose: () => void;
  onResize: (height: number) => void;
  queue: TaskQueueViewClient<TTask, TGroup>;
  presentTask: TaskPresenter<TTask>;
  presentGroup: TaskGroupPresenter<TGroup>;
}

export function TaskQueuePanel<TTask extends TaskViewItem, TGroup extends TaskGroupViewItem>({
  id,
  opened,
  onClose,
  onResize,
  queue,
  presentTask,
  presentGroup,
}: TaskQueuePanelProps<TTask, TGroup>) {
  const { t } = useTranslation('tasks');
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [resizeActive, setResizeActive] = useState(false);
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const entries = topLevelEntries(tasks, groups);
  const hasFinished = entries.some((entry) =>
    entry.kind === 'group' ? isFinishedGroup(entry.group) : isFinishedTask(entry.task),
  );

  const resize = (height: number) => {
    if (!panel.current) return;
    const style = getComputedStyle(panel.current);
    onResize(Math.min(parseFloat(style.maxHeight), Math.max(parseFloat(style.minHeight), height)));
  };

  const isResizeEdge = (clientY: number) => {
    const top = panel.current?.getBoundingClientRect().top;
    return top !== undefined && clientY >= top && clientY <= top + 4;
  };

  const startResize = (event: PointerEvent<HTMLElement>) => {
    if (
      event.target !== event.currentTarget ||
      event.button !== 0 ||
      !event.isPrimary ||
      !panel.current ||
      !isResizeEdge(event.clientY)
    )
      return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizeActive(true);
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: panel.current.getBoundingClientRect().height,
    };
  };

  const moveResize = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (current) {
      if (current.pointerId === event.pointerId)
        resize(current.startHeight + current.startY - event.clientY);
    } else {
      setResizeActive(isResizeEdge(event.clientY));
    }
  };

  const stopResize = (event: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <section
      ref={panel}
      id={id}
      className={classes.panel}
      hidden={!opened}
      aria-label={t('taskQueue')}
      data-resize-active={resizeActive || undefined}
      onPointerDown={startResize}
      onPointerMove={moveResize}
      onPointerUp={stopResize}
      onPointerCancel={stopResize}
      onPointerLeave={() => {
        if (!drag.current) setResizeActive(false);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizeActive(false);
      }}
    >
      <header className={classes.header}>
        <h2>{t('taskQueue')}</h2>
        <span className={classes.total}>{entries.length}</span>
        <div className={classes.actions}>
          <button
            type="button"
            disabled={!hasFinished}
            onClick={() => {
              void queue.clearFinished();
            }}
          >
            {t('clearFinishedTasks')}
          </button>
          <button type="button" aria-label={t('closeTaskQueue')} onClick={onClose}>
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className={classes.contents}>
        {entries.length === 0 ? (
          <p className={classes.empty}>{t('emptyTaskQueue')}</p>
        ) : (
          <ol className={classes.tasks} aria-label={t('taskQueue')}>
            {entries.map((entry) =>
              entry.kind === 'task' ? (
                <TaskQueueItem
                  key={entry.id}
                  task={entry.task}
                  queue={queue}
                  presentTask={presentTask}
                />
              ) : (
                <TaskQueueGroupRow
                  key={entry.id}
                  group={entry.group}
                  presentGroup={presentGroup}
                  queue={queue}
                  presentTask={presentTask}
                />
              ),
            )}
          </ol>
        )}
      </div>
    </section>
  );
}
