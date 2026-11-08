import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Space } from '../../shared/storage';
import { localConnectionId } from '../../shared/storage-browser';
import { StorageError } from '../storage/core/errors';
import { spaceSchema } from '../storage/core/validation';

const snapshotSchema = z
  .strictObject({
    version: z.literal(1),
    folders: z.array(z.string().refine((path) => isAbsolute(path) && !path.includes('\0'))),
    connections: z.array(z.strictObject({ id: z.string().min(1), spaces: z.array(spaceSchema) })),
  })
  .refine(({ connections }) => {
    const ids = new Set<string>();
    for (const { id, spaces } of connections) {
      if (ids.has(id) || new Set(spaces.map((space) => space.id)).size !== spaces.length)
        return false;
      if (
        spaces.some(
          (space) =>
            space.connectionId !== id ||
            space.root.connectionId !== id ||
            space.root.spaceId !== space.id ||
            (id === localConnectionId && space.root.locator !== '.'),
        )
      )
        return false;
      ids.add(id);
    }
    return true;
  });

type Snapshot = z.infer<typeof snapshotSchema>;

interface SnapshotStore {
  read(): unknown;
  write(snapshot: Snapshot): void;
}

export class StoragePreferences {
  private snapshot: Snapshot;

  constructor(private readonly store: SnapshotStore) {
    const saved = store.read();
    const result = snapshotSchema.safeParse(saved ?? { version: 1, folders: [], connections: [] });
    if (!result.success) throw new StorageError('OutcomeUnknown');
    this.snapshot = result.data;
  }

  folders(): readonly string[] {
    return this.snapshot.folders;
  }

  spaces(id: string): Space[] | undefined {
    return this.snapshot.connections.find((connection) => connection.id === id)?.spaces;
  }

  addFolder(path: string): void {
    if (this.snapshot.folders.includes(path)) return;
    this.commit({ ...this.snapshot, folders: [...this.snapshot.folders, path] });
  }

  saveSpaces(id: string, spaces: Space[]): void {
    const connections = this.snapshot.connections.filter((connection) => connection.id !== id);
    this.commit({ ...this.snapshot, connections: [...connections, { id, spaces }] });
  }

  private commit(snapshot: Snapshot): void {
    this.store.write(snapshot);
    this.snapshot = snapshot;
  }
}
