import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Pause,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSize } from '../format/size';
import { useTaskMessageTranslator } from './task-display-context';
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

const statusLabelKeys = {
  paused: 'tasks:taskStatusPaused',
  pausing: 'tasks:taskStatusPausing',
  queued: 'tasks:taskStatusQueued',
  running: 'tasks:taskStatusRunning',
  completed: 'tasks:taskStatusCompleted',
  failed: 'tasks:taskStatusFailed',
  cancelled: 'tasks:taskStatusCancelled',
  partial: 'tasks:taskStatusPartial',
  skipped: 'tasks:taskStatusSkipped',
} as const satisfies Record<TaskRowStatus | 'pausing', string>;

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
  aside?: ReactNode;
  expanded?: boolean | undefined;
  onToggle?: (() => void) | undefined;
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
  aside,
  expanded,
  onToggle,
  details,
}: TaskQueueRowProps) {
  const { t, i18n } = useTranslation(['tasks', 'common']);
  const translateMessage = useTaskMessageTranslator();
  const formatter = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const Icon = statusIcons[status];
  const label = translateMessage(model.typeLabel);
  const resume = status === 'paused';
  const onTogglePause = resume ? onResume : onPause;
  const active = status === 'running' || status === 'paused';
  const failureMessage = (status === 'failed' || status === 'paused') && failure?.message;
  const determinate =
    progress?.kind === 'determinate' &&
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    Number.isFinite(progress.completed);
  const hasNotes = model.resultMessage || summaryNote || failureMessage;
  const Disclosure = expanded ? ChevronDown : ChevronRight;

  const statusIcon = (
    <Icon
      className={classes.statusIcon}
      size={14}
      strokeWidth={1.75}
      aria-label={t(statusLabelKeys[pausing ? 'pausing' : status])}
    />
  );

  // Only phrasing content, so it can sit inside the disclosure button of expandable rows.
  const descriptionContent = (
    <>
      <span className={classes.operation}>
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
        {model.titleNote && (
          <span className={classes.titleNote}>{translateMessage(model.titleNote)}</span>
        )}
      </span>
      <span className={classes.location} title={model.summary}>
        {model.summary}
      </span>
      {active && progress && (
        <span className={classes.progress}>
          {(model.stageLabel ?? progress.stage) && (
            <span>{translateMessage((model.stageLabel ?? progress.stage)!)}</span>
          )}
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
                ? t('tasks:progressBytes', {
                    completed: formatSize(Math.max(0, progress.completed), formatter),
                    total: formatSize(progress.total, formatter),
                  })
                : t('tasks:progressItems', {
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
        </span>
      )}
      {aside && <span className={classes.aside}>{aside}</span>}
      {hasNotes && (
        <span className={classes.notes}>
          {model.resultMessage && <span>{translateMessage(model.resultMessage)}</span>}
          {summaryNote && <span>{summaryNote}</span>}
          {failureMessage && (
            <span className={classes.error}>{translateMessage(failureMessage)}</span>
          )}
        </span>
      )}
    </>
  );

  return (
    <li className={classes.task} data-status={status}>
      <div className={classes.header}>
        {onToggle ? (
          <button
            className={classes.toggle}
            type="button"
            aria-expanded={expanded ?? false}
            onClick={onToggle}
          >
            {statusIcon}
            <span className={classes.description}>{descriptionContent}</span>
            <Disclosure
              className={classes.disclosure}
              size={14}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        ) : (
          <>
            {statusIcon}
            <div className={classes.description}>{descriptionContent}</div>
          </>
        )}
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
      </div>
      {details && <div className={classes.details}>{details}</div>}
    </li>
  );
}
