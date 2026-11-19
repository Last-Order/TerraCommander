import { createContext, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskMessage } from './task-types';

export type TaskMessageTranslator = (message: TaskMessage) => string;

export const TaskDisplayContext = createContext<TaskMessageTranslator | null>(null);

export function useTaskMessageTranslator(): TaskMessageTranslator {
  const { i18n } = useTranslation(['tasks', 'common']);
  const translate = useContext(TaskDisplayContext);
  return (
    translate ??
    ((message) => {
      const value: unknown = i18n.t(
        message.key as never,
        (message.values ? { ...message.values } : undefined) as never,
      );
      return typeof value === 'string' ? value : '';
    })
  );
}
