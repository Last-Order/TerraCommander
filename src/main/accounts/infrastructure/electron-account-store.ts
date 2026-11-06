import Store from 'electron-store';
import type { AccountSnapshot } from '../core/models';
import type { AccountSnapshotStore } from '../core/ports';

/** Construct only after acquiring the application's profile-specific instance lock. */
export class ElectronAccountStore implements AccountSnapshotStore {
  private readonly store: Store<Record<string, unknown>>;

  constructor(directory: string) {
    this.store = new Store({
      cwd: directory,
      name: 'accounts',
      accessPropertiesByDotNotation: false,
      clearInvalidConfig: false,
    });
  }

  read(): unknown {
    const snapshot = this.store.store;
    return Object.keys(snapshot).length === 0 ? undefined : snapshot;
  }

  write(snapshot: AccountSnapshot): void {
    // One replacement keeps metadata and its encrypted grant consistent after a crash.
    this.store.store = structuredClone(snapshot);
  }
}
