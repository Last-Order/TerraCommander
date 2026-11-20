import { app } from 'electron';
import log from 'electron-log/main';
import Store from 'electron-store';
import { TransferPreferences } from './transfer-preferences';

export function createDesktopTransferPreferences(
  profilePath = app.getPath('userData'),
): TransferPreferences {
  const store = new Store<{ concurrencyLimit: unknown }>({
    cwd: profilePath,
    name: 'transfers',
    clearInvalidConfig: true,
  });
  return new TransferPreferences(
    {
      read: () => store.get('concurrencyLimit'),
      write: (concurrencyLimit) => store.set('concurrencyLimit', concurrencyLimit),
    },
    (message) => log.warn(message),
  );
}
