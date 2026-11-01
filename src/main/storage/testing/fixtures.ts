import { Readable } from 'node:stream';
import type {
  ByteRange,
  Capabilities,
  CapabilityScope,
  ConnectionDefinition,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
  SourceDescriptor,
  WriteTarget,
} from '../../../shared/storage/models';
import { targetRef } from '../core/adapter-operations';
import type {
  ByteSource,
  OperationContext,
  ReadHandle,
  ReopenableByteSource,
} from '../core/contracts';
import { StorageError, throwIfAborted } from '../core/errors';
import type { AdapterServices, StorageAdapter } from '../ports/adapter';
import type { CheckpointStore } from '../ports/services';
import { AdapterRegistry } from '../registry/adapter-registry';

/** Synthetic fixtures only; these are not production storage implementations. */
export const fixtureCapabilities: Capabilities = {
  list: { support: 'supported' },
  read: { support: 'supported' },
  rangeRead: { support: 'supported' },
  conditionalRead: { support: 'supported' },
  write: { support: 'supported' },
  conditionalWrite: { support: 'supported' },
  createDirectory: { support: 'supported' },
  remove: { support: 'supported' },
  copyWithin: { support: 'supported' },
  moveWithin: { support: 'supported' },
  resumeWrite: { support: 'supported', guarantees: { durableRecovery: true } },
};

export function fixtureRef(connectionId = 'connection', locator = '', spaceId = 'space'): EntryRef {
  return { connectionId, locator, spaceId };
}

export function fixtureEntry(ref: EntryRef, name = 'item', kind: Entry['kind'] = 'file'): Entry {
  return {
    ref,
    name,
    kind,
    revision: 'revision-1',
    capabilities: structuredClone(fixtureCapabilities),
  };
}

export function readHandle(bytes: Uint8Array, onDispose = () => {}): ReadHandle {
  const stream = Readable.from([bytes], { objectMode: false });
  return {
    stream,
    length: bytes.length,
    async dispose() {
      stream.destroy();
      onDispose();
    },
  };
}

export function byteSource(
  text = 'abcdef',
  verification: SourceDescriptor['verification'] = 'strong',
) {
  const bytes = Buffer.from(text);
  const opened: ByteRange[] = [];
  let disposals = 0;
  const source: ReopenableByteSource = {
    kind: 'reopenable',
    size: bytes.length,
    descriptor: {
      identity: 'source',
      revision: `contents-${text}`,
      size: bytes.length,
      verification,
    },
    async open(range, ctx) {
      throwIfAborted(ctx.signal);
      const offset = range?.offset ?? 0;
      opened.push(range ?? { offset });
      const end = range?.length !== undefined ? offset + range.length : bytes.length;
      return readHandle(bytes.subarray(offset, end), () => {
        disposals += 1;
      });
    },
  };
  return {
    source,
    opened,
    get disposals() {
      return disposals;
    },
  };
}

export async function consume(source: ByteSource, ctx: OperationContext): Promise<Buffer> {
  const handle = await source.open(undefined, ctx);
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of handle.stream) {
      throwIfAborted(ctx.signal);
      chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.dispose();
  }
}

export class FixtureAdapter implements StorageAdapter {
  entries: Entry[] = [];
  calls: string[] = [];
  disposed = 0;
  streamDisposals = 0;
  caps = structuredClone(fixtureCapabilities);
  lastWrite: Buffer | undefined;
  private sequence = 0;

  constructor(readonly connectionId: string) {}

  async listSpaces() {
    this.calls.push('listSpaces');
    return [
      {
        id: 'space',
        connectionId: this.connectionId,
        name: 'Fixture',
        root: fixtureRef(this.connectionId),
      },
    ];
  }

  async capabilities(_scope: CapabilityScope, ctx: OperationContext): Promise<Capabilities> {
    throwIfAborted(ctx.signal);
    return this.caps;
  }

  async stat(ref: EntryRef, ctx: OperationContext): Promise<Entry> {
    throwIfAborted(ctx.signal);
    this.calls.push(`stat:${ref.locator}`);
    if (ref.locator === '') return fixtureEntry(ref, '', 'directory');
    const entry = this.entries.find((entry) => entry.ref.locator === ref.locator);
    if (!entry) throw new StorageError('NotFound');
    return structuredClone(entry);
  }

  async list(_parent: EntryRef, request: ListRequest, ctx: OperationContext): Promise<EntryPage> {
    throwIfAborted(ctx.signal);
    this.calls.push('list');
    const index = Number(request.cursor ?? 0);
    const count = request.pageSize ?? 100;
    const next = index + count;
    return {
      entries: structuredClone(this.entries.slice(index, next)),
      ...(next < this.entries.length ? { nextCursor: String(next) } : {}),
    };
  }

  async read(ref: EntryRef, options: ReadOptions, ctx: OperationContext): Promise<ReadHandle> {
    this.calls.push('read');
    const entry = await this.stat(ref, ctx);
    if (options.expectedRevision !== undefined && options.expectedRevision !== entry.revision)
      throw new StorageError('PreconditionFailed');
    const bytes = Buffer.from('abcdef');
    const offset = options.range?.offset ?? 0;
    const end = options.range?.length !== undefined ? offset + options.range.length : bytes.length;
    return readHandle(bytes.subarray(offset, end), () => {
      this.streamDisposals += 1;
    });
  }

  async write(target: WriteTarget, source: ByteSource, ctx: OperationContext): Promise<Entry> {
    this.calls.push('write');
    this.lastWrite = await consume(source, ctx);
    const ref = targetRef(target);
    return fixtureEntry(
      { ...ref, locator: `written-${++this.sequence}` },
      target.kind === 'create' ? target.name : 'replacement',
    );
  }

  async createDirectory(target: CreateTarget, _ctx: OperationContext): Promise<Entry> {
    this.calls.push('createDirectory');
    return fixtureEntry(
      { ...target.parent, locator: `directory-${++this.sequence}` },
      target.name,
      'directory',
    );
  }

  async remove(_ref: EntryRef, _ctx: OperationContext): Promise<void> {
    this.calls.push('remove');
  }

  async copyWithin(_ref: EntryRef, target: CreateTarget, _ctx: OperationContext): Promise<Entry> {
    this.calls.push('copyWithin');
    return fixtureEntry({ ...target.parent, locator: `copy-${++this.sequence}` }, target.name);
  }

  async moveWithin(_ref: EntryRef, target: CreateTarget, _ctx: OperationContext): Promise<Entry> {
    this.calls.push('moveWithin');
    return fixtureEntry({ ...target.parent, locator: target.name }, target.name);
  }

  async dispose(): Promise<void> {
    this.disposed += 1;
  }
}

export class TestCheckpointStore implements CheckpointStore {
  beforeSave?: (value: unknown) => Promise<void>;
  constructor(readonly records = new Map<string, unknown>()) {}
  async load(id: string): Promise<unknown> {
    return structuredClone(this.records.get(id));
  }
  async save(id: string, value: unknown): Promise<void> {
    await this.beforeSave?.(value);
    this.records.set(id, structuredClone(value));
  }
}

export const fixtureServices: AdapterServices = {
  credentials: {
    async resolve() {
      throw new StorageError('AuthRequired');
    },
  },
  logger: { event() {} },
};

export async function connectFixture(
  adapter = new FixtureAdapter('connection'),
  configuration: ConnectionDefinition['configuration'] = {},
) {
  const registry = new AdapterRegistry(fixtureServices);
  registry.register({
    provider: 'fixture',
    async create() {
      return adapter;
    },
  });
  await registry.connect({ id: adapter.connectionId, provider: 'fixture', configuration });
  return { adapter, registry };
}

export function createTarget(connectionId = 'connection'): WriteTarget {
  return {
    kind: 'create',
    parent: fixtureRef(connectionId),
    name: 'destination',
    policy: 'create-only',
  };
}
