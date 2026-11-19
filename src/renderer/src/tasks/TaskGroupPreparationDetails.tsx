import { useTranslation } from 'react-i18next';
import { useTaskMessageTranslator } from './task-display-context';
import type { TaskGroupPreparation } from './task-types';
import classes from './TaskQueueRow.module.css';

export function TaskGroupPreparationDetails({
  preparation,
}: {
  preparation: TaskGroupPreparation;
}) {
  const { t } = useTranslation('tasks');
  const translateMessage = useTaskMessageTranslator();
  return (
    <>
      {preparation.failure && (
        <p className={classes.error} role="alert">
          {translateMessage(preparation.failure.message)}
        </p>
      )}
      {preparation.issues.length > 0 && (
        <ul className={classes.preparationIssues} aria-label={t('preparationIssuesTitle')}>
          {preparation.issues.map((issue, index) => (
            <li key={index}>
              <span>{issue.label}</span>
              <span className={classes.error}>{translateMessage(issue.failure.message)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
