import { app, safeStorage } from 'electron';
import log from 'electron-log/main';
import { fallbackLanguage, type AppLanguage } from '../../../shared/language';
import { ElectronAccountStore } from '../infrastructure/electron-account-store';
import { SafeStorageAccountCipher } from '../infrastructure/safe-storage-cipher';
import { googleDriveDescriptor } from '../providers/google-drive/descriptor';
import { createAccountServices } from './account-services';

/** Opening the shared account store does not evaluate any provider's authentication module. */
export function createDesktopAccountServices(
  getLanguage: () => AppLanguage = () => fallbackLanguage,
) {
  return createAccountServices({
    store: new ElectronAccountStore(app.getPath('userData')),
    cipher: new SafeStorageAccountCipher(safeStorage),
    logger: { event: (name, fields) => log.info(name, fields) },
    providers: [
      {
        descriptor: googleDriveDescriptor,
        create: async (services, signal) => {
          const module = await import('../providers/google-drive/desktop-provider');
          signal.throwIfAborted();
          return module.createDesktopGoogleDriveProvider(services, getLanguage);
        },
      },
    ],
  });
}
