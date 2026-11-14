import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { DownloadSettings, DownloadsApi } from '../../../shared/downloads';
import type { BrowserResult } from '../../../shared/storage-browser';
import { renderWorkspace } from '../testing/render-app';
import { pausePage, success } from '../testing/storage-browser-fixtures';

afterEach(() => vi.unstubAllGlobals());

async function setup(save?: DownloadsApi['setDirectory']) {
  const user = userEvent.setup();
  let settings: DownloadSettings = { directory: 'D:\\Downloads' };
  const chooseDirectory = vi.fn<DownloadsApi['chooseDirectory']>(async () => success(null));
  const setDirectory = vi.fn<DownloadsApi['setDirectory']>(
    save ??
      (async (directory) => {
        settings = { directory };
        return success(settings);
      }),
  );
  vi.stubGlobal('desktop', {
    storage: { listConnections: async () => success([]) },
    downloads: { getSettings: async () => success(settings), chooseDirectory, setDirectory },
  });
  await renderWorkspace();
  await user.click(screen.getByRole('button', { name: '设置' }));
  const modal = within(await screen.findByRole('dialog', { name: '设置' }));
  await user.click(modal.getByRole('tab', { name: '传输' }));
  const input = modal.getByRole('textbox', { name: '默认下载目录' });
  await waitFor(() => expect(input).toHaveValue('D:\\Downloads'));
  return { user, modal, input, chooseDirectory, setDirectory };
}

it('applies typed directories automatically and picker selections immediately', async () => {
  const { user, modal, input, chooseDirectory, setDirectory } = await setup();
  expect(chooseDirectory).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, 'E:\\Saved');
  await waitFor(() => expect(setDirectory).toHaveBeenCalledExactlyOnceWith('E:\\Saved'));
  await user.click(modal.getByRole('button', { name: '浏览…' }));
  expect(chooseDirectory).toHaveBeenCalledWith('E:\\Saved');
  expect(input).toHaveValue('E:\\Saved');
  expect(setDirectory).toHaveBeenCalledOnce();
  chooseDirectory.mockResolvedValueOnce(success('F:\\Selected'));
  await user.click(modal.getByRole('button', { name: '浏览…' }));
  expect(setDirectory).toHaveBeenLastCalledWith('F:\\Selected');
  expect(input).toHaveValue('F:\\Selected');
});

it('applies the last edit when settings close before the typing delay expires', async () => {
  const { modal, input, setDirectory } = await setup();
  fireEvent.change(input, { target: { value: 'E:\\Closing' } });
  fireEvent.click(modal.getByRole('button', { name: '关闭' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(setDirectory).toHaveBeenCalledExactlyOnceWith('E:\\Closing'));
});

it('keeps newer edits when an older save finishes later', async () => {
  const first = pausePage<BrowserResult<DownloadSettings>>();
  const second = pausePage<BrowserResult<DownloadSettings>>();
  const { input, setDirectory } = await setup((directory) =>
    directory === 'E:\\First' ? first.promise : second.promise,
  );
  fireEvent.change(input, { target: { value: 'E:\\First' } });
  fireEvent.blur(input);
  expect(setDirectory).toHaveBeenCalledWith('E:\\First');
  expect(input).not.toBeDisabled();
  fireEvent.change(input, { target: { value: 'F:\\Latest' } });
  fireEvent.blur(input);
  expect(setDirectory).toHaveBeenLastCalledWith('F:\\Latest');
  await act(async () => {
    second.resolve(success({ directory: 'F:\\Latest' }));
  });
  await act(async () => {
    first.resolve(success({ directory: 'E:\\First' }));
  });
  expect(input).toHaveValue('F:\\Latest');
});

it('shows a rejected auto-save without discarding the edited path', async () => {
  const { modal, input, setDirectory } = await setup();
  setDirectory.mockResolvedValue({ ok: false, code: 'InvalidDownloadDirectory' });
  fireEvent.change(input, { target: { value: 'invalid-directory' } });
  fireEvent.blur(input);
  expect(await modal.findByRole('alert')).toBeInTheDocument();
  expect(input).toHaveValue('invalid-directory');
});
