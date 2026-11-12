import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { expect, it, vi } from 'vitest';
import { createRendererI18n } from '../i18n/create-renderer-i18n';
import { TaskQueueRow } from './TaskQueueRow';
import type { TaskRowModel } from './task-row-model';
import type { TaskProgress } from './task-types';

const model: TaskRowModel = {
  typeLabel: { key: 'storage:renameEntry' },
  title: [{ text: 'old.txt' }, { text: '→', secondary: true }, { text: 'new.txt' }],
  summary: 'Disk',
};

it('retranslates task labels and failures when the language changes', async () => {
  const i18n = await createRendererI18n('zh-CN');
  render(
    <I18nextProvider i18n={i18n}>
      <TaskQueueRow
        status="failed"
        model={model}
        failure={{ code: 'InvalidArgument', message: { key: 'storage:invalidEntryName' } }}
      />
    </I18nextProvider>,
  );
  expect(screen.getByText('重命名')).toBeInTheDocument();
  expect(screen.getByText('请输入有效的名称。')).toBeInTheDocument();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
  expect(screen.getByText('Rename')).toBeInTheDocument();
  expect(screen.getByText('Failed')).toBeInTheDocument();
  expect(screen.getByText('Enter a valid name.')).toBeInTheDocument();
  expect(screen.getByText('old.txt')).toBeInTheDocument();
  expect(screen.getByText('new.txt')).toBeInTheDocument();
});

it('renders optional progress without inventing a total and updates known progress', async () => {
  const i18n = await createRendererI18n('zh-CN');
  const row = (progress?: TaskProgress) => (
    <I18nextProvider i18n={i18n}>
      <TaskQueueRow status="running" model={model} progress={progress} />
    </I18nextProvider>
  );
  const { rerender } = render(row());
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  rerender(row({ kind: 'indeterminate' }));
  expect(screen.getByRole('progressbar', { name: '重命名进度' })).not.toHaveAttribute('value');
  rerender(row({ kind: 'determinate', completed: 2, total: 4, unit: 'items' }));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '2');
  expect(screen.getByRole('progressbar')).toHaveAttribute('max', '4');
  expect(screen.getByText('2 / 4 项')).toBeInTheDocument();
  rerender(row({ kind: 'determinate', completed: 0, total: 0, unit: 'items' }));
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('value');
  expect(screen.queryByText('0 / 0 项')).not.toBeInTheDocument();
});

it('only renders supplied actions and honors their disabled state', async () => {
  const i18n = await createRendererI18n('zh-CN');
  const user = userEvent.setup();
  const retry = vi.fn();
  const cancel = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <TaskQueueRow
        status="failed"
        model={{
          ...model,
          actions: [
            { id: 'retry', label: { key: 'common:retry' }, onClick: retry },
            { id: 'cancel', label: { key: 'common:cancel' }, disabled: true, onClick: cancel },
          ],
        }}
      />
    </I18nextProvider>,
  );
  await user.click(screen.getByRole('button', { name: '重试' }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
});
