import { Check, CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { rendererNamespaces } from '../i18n/create-renderer-i18n';
import type { TaskRowModel } from './task-row-model';
import type { TaskFailure, TaskProgress, TaskStatus } from './task-types';
import classes from './TaskQueueRow.module.css';

const statusIcons = {
  queued: Clock3,
  running: LoaderCircle,
  completed: Check,
  failed: CircleAlert,
};

interface TaskQueueRowProps {
  status: TaskStatus;
  model: TaskRowModel;
  progress?: TaskProgress | undefined;
  failure?: TaskFailure | undefined;
}

export function TaskQueueRow({ status, model, progress, failure }: TaskQueueRowProps) {
  const { t } = useTranslation(rendererNamespaces);
  const Icon = statusIcons[status];
  const label = t(model.typeLabel.key, { ...model.typeLabel.values });
  const determinate =
    progress?.kind === 'determinate' &&
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    Number.isFinite(progress.completed);

  return (
    <li className={classes.task} data-status={status}>
      <Icon className={classes.statusIcon} size={16} strokeWidth={1.5} aria-hidden="true" />
      <div className={classes.description}>
        <div className={classes.operation}>
          <span className={classes.type}>{label}</span>
          {model.title.map((part, index) => (
            <span
              key={index}
              className={classes.titlePart}
              data-secondary={part.secondary || undefined}
              title={part.text}
            >
              {part.text}
            </span>
          ))}
        </div>
        {model.summary && (
          <div className={classes.summary} title={model.summary}>
            {model.summary}
          </div>
        )}
        {status === 'running' && progress && (
          <div className={classes.progress}>
            {progress.stage && <span>{t(progress.stage.key, { ...progress.stage.values })}</span>}
            <progress
              aria-label={t('tasks:progress', { task: label })}
              max={determinate ? progress.total : undefined}
              value={
                determinate ? Math.max(0, Math.min(progress.completed, progress.total)) : undefined
              }
            />
            {determinate && (
              <span>
                {t(`tasks:progress_${progress.unit}`, {
                  completed: progress.completed,
                  total: progress.total,
                })}
              </span>
            )}
          </div>
        )}
        {status === 'failed' && failure && (
          <p className={classes.error}>{t(failure.message.key, { ...failure.message.values })}</p>
        )}
      </div>
      <span className={classes.status}>{t(`tasks:taskStatus_${status}`)}</span>
      {model.actions && model.actions.length > 0 && (
        <div className={classes.actions}>
          {model.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              disabled={action.disabled}
              onClick={action.onClick}
            >
              {t(action.label.key, { ...action.label.values })}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
