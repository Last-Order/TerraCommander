import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { localConnectionId } from '../../shared/storage-browser';
import { StorageError } from '../storage/core/errors';

const snapshotVersion = 2;
const savedSpaceSchema = z.strictObject({
  id: z.string().min(1),
  cached: z.strictObject({ name: z.string(), locator: z.string() }).optional(),
});

const snapshotSchema = z
  .strictObject({
    version: z.literal(snapshotVersion),
    folders: z.array(z.string().refine((path) => isAbsolute(path) && !path.includes('\0'))),
    connections: z.array(
      z.strictObject({ id: z.string().min(1), spaces: z.array(savedSpaceSchema) }),
    ),
  })
  .refine(({ connections }) => {
    const ids = new Set<string>();
    for (const { id, spaces } of connections) {
      if (ids.has(id) || new Set(spaces.map((space) => space.id)).size !== spaces.length)
        return false;
      if (id === localConnectionId && spaces.some(({ cached }) => cached?.locator !== '.'))
        return false;
      ids.add(id);
    }
    return true;
  });

type Snapshot = z.infer<typeof snapshotSchema>;
type SavedSpace = z.infer<typeof savedSpaceSchema>;

interface SnapshotStore {
  read(): unknown;
  write(snapshot: Snapshot): void;
}

export class StoragePreferences {
  private snapshot: Snapshot;

  constructor(private readonly store: SnapshotStore) {
    const saved = store.read();
    const result = snapshotSchema.safeParse(
      saved ?? { version: snapshotVersion, folders: [], connections: [] },
    );
    if (!result.success) throw new StorageError('OutcomeUnknown');
    this.snapshot = result.data;
  }

  folders(): readonly string[] {
    return this.snapshot.folders;
  }

  selectedSpaces(id: string): SavedSpace[] | undefined {
    return this.snapshot.connections.find((connection) => connection.id === id)?.spaces;
  }

  addFolder(path: string): void {
    if (this.snapshot.folders.includes(path)) return;
    this.commit({ ...this.snapshot, folders: [...this.snapshot.folders, path] });
  }

  saveSpaces(id: string, spaces: SavedSpace[]): void {
    const connections = this.snapshot.connections.filter((connection) => connection.id !== id);
    this.commit({ ...this.snapshot, connections: [...connections, { id, spaces }] });
  }

  private commit(snapshot: Snapshot): void {
    this.store.write(snapshot);
    this.snapshot = snapshot;
  }
}
