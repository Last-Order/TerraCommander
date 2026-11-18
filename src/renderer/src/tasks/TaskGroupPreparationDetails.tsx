import { useTranslation } from 'react-i18next';
import { rendererNamespaces } from '../i18n/create-renderer-i18n';
import type { TaskGroupPreparation } from './task-group-types';
import classes from './TaskQueueRow.module.css';

export function TaskGroupPreparationDetails({
  preparation,
}: {
  preparation: TaskGroupPreparation;
}) {
  const { t } = useTranslation(rendererNamespaces);
  return (
    <>
      {preparation.failure && (
        <p className={classes.error} role="alert">
          {t(preparation.failure.message.key, { ...preparation.failure.message.values })}
        </p>
      )}
      {preparation.issues.length > 0 && (
        <ul className={classes.preparationIssues} aria-label={t('tasks:preparationIssuesTitle')}>
          {preparation.issues.map((issue, index) => (
            <li key={index}>
              <span>{issue.label}</span>
              <span className={classes.error}>
                {t(issue.failure.message.key, { ...issue.failure.message.values })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
