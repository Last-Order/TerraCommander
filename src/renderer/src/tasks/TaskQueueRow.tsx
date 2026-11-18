import { Check, CircleAlert, Clock3, LoaderCircle, Pause, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { rendererNamespaces } from '../i18n/create-renderer-i18n';
import { formatSize } from '../format/size';
import type { TaskRowModel, TaskRowStatus } from './task-row-model';
import type { TaskFailure, TaskProgress } from './task-types';
import classes from './TaskQueueRow.module.css';

const statusIcons = {
  queued: Clock3,
  running: LoaderCircle,
  paused: Pause,
  completed: Check,
  failed: CircleAlert,
  cancelled: X,
  partial: CircleAlert,
  skipped: X,
};

interface TaskQueueRowProps {
  status: TaskRowStatus;
  model: TaskRowModel;
  progress?: TaskProgress | undefined;
  failure?: TaskFailure | undefined;
  onCancel?: (() => void) | undefined;
  onPause?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  pauseSupported?: boolean | undefined;
  cancelSupported?: boolean | undefined;
  pausing?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  summaryNote?: ReactNode;
  action?: ReactNode;
  details?: ReactNode;
}

export function TaskQueueRow({
  status,
  model,
  progress,
  failure,
  onCancel,
  onPause,
  onResume,
  pauseSupported = onPause !== undefined || onResume !== undefined,
  cancelSupported = onCancel !== undefined,
  pausing,
  onRetry,
  summaryNote,
  action,
  details,
}: TaskQueueRowProps) {
  const { t, i18n } = useTranslation(rendererNamespaces);
  const formatter = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const Icon = statusIcons[status];
  const label = t(model.typeLabel.key, { ...model.typeLabel.values });
  const resume = status === 'paused';
  const onTogglePause = resume ? onResume : onPause;
  const determinate =
    progress?.kind === 'determinate' &&
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    Number.isFinite(progress.completed);

  return (
    <li className={classes.task} data-status={status} data-compact={model.compact || undefined}>
      <Icon
        className={classes.statusIcon}
        size={16}
        strokeWidth={1.5}
        aria-label={t(`tasks:taskStatus_${pausing ? 'pausing' : status}`)}
      />
      <div className={classes.description}>
        <div className={classes.information}>
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
          {model.resultMessage && (
            <p className={classes.summary}>
              {t(model.resultMessage.key, { ...model.resultMessage.values })}
            </p>
          )}
          {summaryNote && <p className={classes.summary}>{summaryNote}</p>}
          {status === 'failed' && failure && (
            <p className={classes.error}>{t(failure.message.key, { ...failure.message.values })}</p>
          )}
        </div>
        {(status === 'running' || status === 'paused') && !model.compact && progress?.summary && (
          <p className={classes.summary}>
            {t(progress.summary.key, { ...progress.summary.values })}
          </p>
        )}
        {(status === 'running' || status === 'paused') && progress && (
          <div className={classes.progress}>
            {model.compact && progress.summary && (
              <span>{t(progress.summary.key, { ...progress.summary.values })}</span>
            )}
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
                {progress.unit === 'bytes'
                  ? t('tasks:progress_bytes', {
                      completed: formatSize(Math.max(0, progress.completed), formatter),
                      total: formatSize(progress.total, formatter),
                    })
                  : t('tasks:progress_items', {
                      completed: progress.completed,
                      total: progress.total,
                    })}
              </span>
            )}
            {progress.kind === 'indeterminate' &&
              progress.completedBytes !== undefined &&
              Number.isFinite(progress.completedBytes) &&
              progress.completedBytes >= 0 && (
                <span>{formatSize(progress.completedBytes, formatter)}</span>
              )}
            {status === 'running' &&
              !pausing &&
              progress.bytesPerSecond !== undefined &&
              Number.isFinite(progress.bytesPerSecond) &&
              progress.bytesPerSecond >= 0 && (
                <span aria-label={t('tasks:transferRate')}>
                  {t('tasks:progressRate', {
                    rate: formatSize(progress.bytesPerSecond, formatter),
                  })}
                </span>
              )}
          </div>
        )}
      </div>
      {action}
      {pauseSupported && (
        <button
          className={classes.control}
          type="button"
          onClick={onTogglePause}
          disabled={!onTogglePause}
        >
          <span className={classes.controlLabel} aria-hidden={resume}>
            {t('tasks:pause')}
          </span>
          <span className={classes.controlLabel} aria-hidden={!resume}>
            {t('tasks:resume')}
          </span>
        </button>
      )}
      {cancelSupported && (
        <button className={classes.control} type="button" onClick={onCancel} disabled={!onCancel}>
          {t('common:cancel')}
        </button>
      )}
      {onRetry && (
        <button className={classes.control} type="button" onClick={onRetry}>
          {t('common:retry')}
        </button>
      )}
      {details && <div className={classes.details}>{details}</div>}
    </li>
  );
}
