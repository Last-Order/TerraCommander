import { z } from 'zod';
import { StorageError } from '@main/storage/core/errors';
import { spaceSchema } from '@main/storage/core/validation';
import type { Space } from '@shared/storage';

const snapshotVersion = 4;
const savedSpaceSchema = z.strictObject({
  id: z.string().min(1),
  cached: z.strictObject({ name: z.string(), locator: z.string() }).optional(),
});

const baseSnapshotSchema = z.strictObject({
  version: z.literal(snapshotVersion),
  connections: z.array(
    z.strictObject({
      id: z.string().min(1),
      provider: z.string().min(1),
      spaces: z.array(savedSpaceSchema).optional(),
      discovered: z.array(spaceSchema).optional(),
    }),
  ),
});

type SpaceValidator = (provider: string, space: { id: string; locator?: string }) => boolean;

function createSnapshotSchema(validateSpace?: SpaceValidator) {
  return baseSnapshotSchema.refine(({ connections }) => {
    const ids = new Set<string>();
    for (const { id, provider, spaces = [], discovered = [] } of connections) {
      if (ids.has(id) || new Set(spaces.map((space) => space.id)).size !== spaces.length)
        return false;
      if (
        validateSpace &&
        spaces.some(
          (space) =>
            !validateSpace(provider, {
              id: space.id,
              ...(space.cached ? { locator: space.cached.locator } : {}),
            }),
        )
      )
        return false;
      if (
        new Set(discovered.map((space) => space.id)).size !== discovered.length ||
        discovered.some(
          (space) =>
            space.connectionId !== id ||
            space.root.connectionId !== id ||
            space.root.spaceId !== space.id ||
            (validateSpace !== undefined &&
              !validateSpace(provider, { id: space.id, locator: space.root.locator })),
        )
      )
        return false;
      ids.add(id);
    }
    return true;
  });
}

type Snapshot = z.infer<typeof baseSnapshotSchema>;
type SavedSpace = z.infer<typeof savedSpaceSchema>;

interface SnapshotStore {
  read(): unknown;
  write(snapshot: Snapshot): void;
}

export interface StoragePreferencesOptions {
  validateSpace?: SpaceValidator;
}

export class StoragePreferences {
  private snapshot: Snapshot;

  constructor(
    private readonly store: SnapshotStore,
    options: StoragePreferencesOptions = {},
  ) {
    const saved = store.read();
    const result = createSnapshotSchema(options.validateSpace).safeParse(
      saved ?? { version: snapshotVersion, connections: [] },
    );
    if (!result.success) throw new StorageError('OutcomeUnknown');
    this.snapshot = result.data;
  }

  selectedSpaces(id: string): SavedSpace[] | undefined {
    return this.snapshot.connections.find((connection) => connection.id === id)?.spaces;
  }

  discoveredSpaces(id: string): Space[] | undefined {
    return this.snapshot.connections.find((connection) => connection.id === id)?.discovered;
  }

  saveSpaces(id: string, provider: string, spaces: SavedSpace[]): void {
    this.updateConnection(id, provider, { spaces });
  }

  saveDiscoveredSpaces(id: string, provider: string, discovered: Space[]): void {
    this.updateConnection(id, provider, { discovered });
  }

  private updateConnection(
    id: string,
    provider: string,
    update: { spaces?: SavedSpace[]; discovered?: Space[] },
  ) {
    const previous = this.snapshot.connections.find((connection) => connection.id === id);
    const connections = this.snapshot.connections.filter((connection) => connection.id !== id);
    this.commit({
      ...this.snapshot,
      connections: [...connections, { ...previous, id, provider, ...update }],
    });
  }

  private commit(snapshot: Snapshot): void {
    this.store.write(snapshot);
    this.snapshot = snapshot;
  }
}
