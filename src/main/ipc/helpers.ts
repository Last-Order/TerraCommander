import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { BrowserResult } from '@shared/storage-browser';
import { AccountError } from '../accounts/core/errors';
import { isTrustedRenderer } from '../security';
import { DownloadError } from '../services/downloads/download-paths';
import { normalizeStorageError } from '../storage/core/errors';

export interface TrustedIpc {
  assertTrusted(event: IpcMainInvokeEvent): BrowserWindow;
  handle<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (window: BrowserWindow, ...args: A) => T | Promise<T>,
  ): void;
  observeRendererSession(window: BrowserWindow, onReset: (owner: number) => void): void;
}

export function createTrustedIpc(
  getWindow: () => BrowserWindow | null,
  entryUrl: string,
): TrustedIpc {
  const observed = new Map<number, Set<(owner: number) => void>>();

  function assertTrusted(event: IpcMainInvokeEvent): BrowserWindow {
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isTrustedRenderer(event.senderFrame.url, entryUrl)
    ) {
      throw new Error('Untrusted IPC sender');
    }
    return window;
  }

  function handle<A extends unknown[], T>(
    channel: string,
    schema: z.ZodType<A>,
    run: (window: BrowserWindow, ...args: A) => T | Promise<T>,
  ): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<BrowserResult<T>> => {
      const window = assertTrusted(event);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return { ok: false, code: 'InvalidArgument' };
      try {
        return { ok: true, value: await run(window, ...parsed.data) };
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof AccountError || error instanceof DownloadError
              ? error.code
              : normalizeStorageError(error).code,
        };
      }
    });
  }

  function observeRendererSession(window: BrowserWindow, onReset: (owner: number) => void): void {
    if (
      window.webContents.isDestroyed() ||
      !isTrustedRenderer(window.webContents.mainFrame.url, entryUrl)
    ) {
      throw new Error('Renderer session closed');
    }
    const owner = window.webContents.id;
    let listeners = observed.get(owner);
    if (!listeners) {
      listeners = new Set();
      observed.set(owner, listeners);
      const reset = () => {
        for (const callback of [...(observed.get(owner) ?? [])]) callback(owner);
      };
      window.webContents.on('render-process-gone', reset);
      window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
        if (isMainFrame) reset();
      });
      window.webContents.once('destroyed', () => {
        reset();
        observed.delete(owner);
      });
    }
    listeners.add(onReset);
  }

  return { assertTrusted, handle, observeRendererSession };
}
