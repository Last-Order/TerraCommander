import { expect, it, vi } from 'vitest';

const host = vi.hoisted(() => {
  const callbacks = new Map<string, (event: { preventDefault(): void }) => void>();
  const window = {
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    },
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isMinimized: vi.fn(() => false),
    loadFile: vi.fn(async () => undefined),
  };
  return {
    callbacks,
    window,
    app: {
      isPackaged: true,
      whenReady: vi.fn(async () => undefined),
      getPath: vi.fn(() => 'D:/test-profile'),
      getVersion: vi.fn(() => 'test'),
      setPath: vi.fn(),
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      quit: vi.fn(),
      on: vi.fn((event: string, callback: (event: { preventDefault(): void }) => void) => {
        callbacks.set(event, callback);
      }),
    },
  };
});

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('electron', () => ({
  app: host.app,
  BrowserWindow: Object.assign(
    vi.fn(function () {
      return host.window;
    }),
    {
      getAllWindows: () => [host.window],
    },
  ),
  session: {
    defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), error: vi.fn() } }));
vi.mock('./ipc', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('./accounts/runtime/desktop-accounts', () => {
  throw new Error('Ordinary application startup must not load Google Drive or its account store.');
});

it('opens the main window and shuts down without loading Google Drive', async () => {
  await import('.');
  await vi.waitFor(() => expect(host.window.loadFile).toHaveBeenCalledTimes(1));
  const beforeQuit = host.callbacks.get('before-quit');
  expect(beforeQuit).toBeDefined();
  const preventDefault = vi.fn();
  beforeQuit?.({ preventDefault });
  await vi.waitFor(() => expect(host.app.quit).toHaveBeenCalledTimes(1));
  expect(preventDefault).toHaveBeenCalledTimes(1);
});
