import { z } from 'zod';
import type {
  Capabilities,
  CapabilityScope,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
  RemoveOptions,
  Space,
  WriteTarget,
} from '@shared/storage/models';
import {
  checkedEntry,
  getCapabilities,
  readRequirements,
  requireCapabilities,
  scopeConnection,
  targetRef,
  writeRequirements,
} from '../core/adapter-operations';
import type {
  AdapterWriteSession,
  ByteSource,
  DirectoryScope,
  OperationContext,
  ReadHandle,
  ReopenableByteSource,
  WriteExecution,
  WriteOptions,
} from '../core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '../core/errors';
import { managedRead, scopeSource } from '../core/streams';
import {
  createTargetSchema,
  entryNameSchema,
  entryRefSchema,
  listRequestSchema,
  parse,
  readOptionsSchema,
  removeOptionsSchema,
  scopeSchema,
  spaceSchema,
  writeTargetSchema,
} from '../core/validation';
import type { StorageAdapter } from '../ports/adapter';
import type { AdapterLease, AdapterRegistry } from '../registry/adapter-registry';
import { CursorCodec } from './cursors';

const DEFAULT_PAGE_SIZE = 100;

/** Validates and routes requests without translating native provider identities or protocols. */
export class StorageAccess {
  private readonly cursors = new CursorCodec();

  constructor(private readonly registry: AdapterRegistry) {}

  async listSpaces(connectionId: string, context: OperationContext = {}): Promise<Space[]> {
    return this.withConnection(connectionId, context, async ({ adapter, context }) => {
      const spaces = parse(
        z.array(spaceSchema),
        await adapter.listSpaces(context),
        'OutcomeUnknown',
      );
      validateSpaceOwnership(spaces, connectionId);
      return spaces;
    });
  }

  async stat(input: EntryRef, context: OperationContext = {}): Promise<Entry> {
    const ref = parse(entryRefSchema, input);
    return this.withConnection(ref.connectionId, context, async ({ adapter, context }) =>
      checkedEntry(await adapter.stat(ref, context), ref.connectionId, ref.spaceId),
    );
  }

  async capabilities(
    input: CapabilityScope,
    context: OperationContext = {},
  ): Promise<Capabilities> {
    const scope = parse(scopeSchema, input);
    return this.withConnection(scopeConnection(scope), context, ({ adapter, context }) =>
      getCapabilities(adapter, scope, context),
    );
  }

  async ancestorLocators(
    input: EntryRef,
    context: OperationContext = {},
  ): Promise<readonly string[] | undefined> {
    const ref = parse(entryRefSchema, input);
    return this.withConnection(ref.connectionId, context, async ({ adapter, context }) => {
      if (!adapter.ancestorLocators) return undefined;
      return adapter.ancestorLocators(ref, context);
    });
  }

  async list(
    input: EntryRef,
    inputRequest: ListRequest = {},
    context: OperationContext = {},
  ): Promise<EntryPage> {
    const ref = parse(entryRefSchema, input);
    const request = parse(listRequestSchema, inputRequest);
    return this.withConnection(
      ref.connectionId,
      context,
      async ({ adapter, context, fingerprint }) => {
        const pageSize = request.pageSize ?? DEFAULT_PAGE_SIZE;
        const adapterRequest: ListRequest = { pageSize };

        if (request.cursor) {
          adapterRequest.cursor = this.cursors.decode(request.cursor, ref, pageSize, fingerprint);
        }

        await requireCapabilities(adapter, ref, [{ operation: 'list' }], context);
        if (!adapter.list) {
          throw new StorageError('Unsupported');
        }

        const page = await adapter.list(ref, adapterRequest, context);
        const hasInvalidCursor =
          page.nextCursor !== undefined &&
          (typeof page.nextCursor !== 'string' || !page.nextCursor);

        if (!Array.isArray(page.entries) || hasInvalidCursor) {
          throw new StorageError('OutcomeUnknown');
        }

        const result: EntryPage = {
          entries: page.entries.map((entry) => checkedEntry(entry, ref.connectionId, ref.spaceId)),
        };

        // Empty pages can still continue. Bind the adapter token to this exact listing request.
        if (page.nextCursor !== undefined) {
          result.nextCursor = this.cursors.encode(ref, pageSize, fingerprint, page.nextCursor);
        }

        return result;
      },
    );
  }

  async read(
    input: EntryRef,
    inputOptions: ReadOptions = {},
    context: OperationContext = {},
  ): Promise<ReadHandle> {
    const ref = parse(entryRefSchema, input);
    const options = parse(readOptionsSchema, inputOptions);
    const lease = await this.registry.acquire(ref.connectionId, context);
    let providerHandle: ReadHandle | undefined;
    try {
      await requireCapabilities(lease.adapter, ref, readRequirements(options), lease.context);
      if (!lease.adapter.read) {
        throw new StorageError('Unsupported');
      }

      providerHandle = await lease.adapter.read(ref, options, lease.context);
      validateReadResult(providerHandle, options);

      // Returning a stream transfers lease ownership; cleanup releases it after consumption.
      return managedRead(providerHandle, lease.context, () => lease.release());
    } catch (error) {
      try {
        await providerHandle?.dispose();
      } finally {
        lease.release();
      }
      throw normalizeStorageError(error);
    }
  }

  async write(
    input: WriteTarget,
    source: ByteSource,
    context: OperationContext = {},
    options?: WriteOptions,
  ): Promise<Entry> {
    const target = parse(writeTargetSchema, input);
    const ref = targetRef(target);
    return this.withConnection(ref.connectionId, context, async ({ adapter, context }) => {
      await requireCapabilities(
        adapter,
        ref,
        writeRequirements(target, { oneShot: source.kind === 'one-shot' }),
        context,
      );
      if (!adapter.write) {
        throw new StorageError('Unsupported');
      }
      const sourceScope = scopeSource(source, context);
      try {
        return checkedEntry(
          await adapter.write(target, sourceScope.source, context, options),
          ref.connectionId,
          ref.spaceId,
        );
      } finally {
        await sourceScope.dispose();
      }
    });
  }

  createWriteSession(
    input: WriteTarget,
    source: ReopenableByteSource,
    options?: WriteOptions,
  ): WriteExecution {
    const target = parse(writeTargetSchema, input);
    const ref = targetRef(target);
    let prepared: { adapter: StorageAdapter; session: AdapterWriteSession } | undefined;
    let running = false;
    const run: WriteExecution['run'] = (context) =>
      this.withConnection(ref.connectionId, context, async (lease) => {
        const { adapter, context: operation } = lease;
        if (!prepared) {
          const { pauseSignal } = context;
          const signal =
            pauseSignal && operation.signal
              ? AbortSignal.any([pauseSignal, operation.signal])
              : (pauseSignal ?? operation.signal);
          const preparation = signal ? { ...operation, signal } : operation;
          await requireCapabilities(
            adapter,
            ref,
            writeRequirements(target, { pausable: true }),
            preparation,
          );
          if (!adapter.prepareWrite) throw new StorageError('Unsupported');
          const session = await adapter.prepareWrite(
            target,
            source.descriptor,
            preparation,
            options,
          );
          prepared = { adapter, session };
        }
        if (prepared.adapter !== adapter) throw new StorageError('ResumeInvalid');
        const scoped = scopeSource(source, operation);
        try {
          if (scoped.source.kind !== 'reopenable') throw new StorageError('ResumeInvalid');
          const entry = await prepared.session.run(scoped.source, { ...context, ...operation });
          return checkedEntry(entry, ref.connectionId, ref.spaceId);
        } finally {
          await scoped.dispose();
        }
      });
    return {
      async run(context) {
        if (running) throw new StorageError('PreconditionFailed');
        running = true;
        try {
          return await run(context);
        } finally {
          running = false;
        }
      },
      discard: async (context = {}) => {
        if (running) throw new StorageError('PreconditionFailed');
        const current = prepared;
        prepared = undefined;
        if (!current?.session.discard) return;
        await this.withConnection(
          ref.connectionId,
          context,
          async ({ adapter, context: operation }) => {
            if (current.adapter !== adapter) return;
            await current.session.discard?.(operation);
          },
        );
      },
    };
  }

  async openDirectoryScope(
    input: EntryRef,
    context: OperationContext = {},
  ): Promise<DirectoryScope> {
    const root = parse(entryRefSchema, input);
    return this.withConnection(root.connectionId, context, async ({ adapter, context }) => {
      if (adapter.openDirectoryScope) {
        return adapter.openDirectoryScope(root, context);
      }
      const rootEntry = checkedEntry(
        await adapter.stat(root, context),
        root.connectionId,
        root.spaceId,
      );
      if (rootEntry.kind !== 'directory') throw new StorageError('InvalidArgument');
      return this.createDefaultDirectoryScope(root);
    });
  }

  async createDirectory(input: CreateTarget, context: OperationContext = {}): Promise<Entry> {
    const target = parse(createTargetSchema, input);
    return this.withConnection(
      target.parent.connectionId,
      context,
      async ({ adapter, context }) => {
        await requireCapabilities(
          adapter,
          target.parent,
          [{ operation: 'createDirectory' }],
          context,
        );
        if (!adapter.createDirectory) {
          throw new StorageError('Unsupported');
        }
        return checkedEntry(
          await adapter.createDirectory(target, context),
          target.parent.connectionId,
          target.parent.spaceId,
        );
      },
    );
  }

  async remove(
    input: EntryRef,
    context: OperationContext = {},
    inputOptions?: RemoveOptions,
  ): Promise<void> {
    const ref = parse(entryRefSchema, input);
    const options =
      inputOptions !== undefined ? parse(removeOptionsSchema, inputOptions) : undefined;
    await this.withConnection(ref.connectionId, context, async ({ adapter, context }) => {
      await requireCapabilities(adapter, ref, [{ operation: 'remove' }], context);
      if (!adapter.remove) {
        throw new StorageError('Unsupported');
      }
      await adapter.remove(ref, context, options);
    });
  }

  async copyWithin(
    ref: EntryRef,
    target: CreateTarget,
    context: OperationContext = {},
  ): Promise<Entry> {
    return this.runNativeMutation('copyWithin', ref, target, context);
  }

  async moveWithin(
    ref: EntryRef,
    target: CreateTarget,
    context: OperationContext = {},
  ): Promise<Entry> {
    return this.runNativeMutation('moveWithin', ref, target, context);
  }

  async rename(input: EntryRef, inputName: string, context: OperationContext = {}): Promise<Entry> {
    const ref = parse(entryRefSchema, input);
    const name = parse(entryNameSchema, inputName);
    return this.withConnection(ref.connectionId, context, async ({ adapter, context }) => {
      await requireCapabilities(adapter, ref, [{ operation: 'rename' }], context);
      if (!adapter.rename) throw new StorageError('Unsupported');
      return checkedEntry(await adapter.rename(ref, name, context), ref.connectionId, ref.spaceId);
    });
  }

  private async runNativeMutation(
    operation: 'copyWithin' | 'moveWithin',
    input: EntryRef,
    inputTarget: CreateTarget,
    context: OperationContext,
  ): Promise<Entry> {
    const ref = parse(entryRefSchema, input);
    const target = parse(createTargetSchema, inputTarget);
    if (ref.connectionId !== target.parent.connectionId) {
      throw new StorageError('Unsupported');
    }
    return this.withConnection(ref.connectionId, context, async ({ adapter, context }) => {
      await requireCapabilities(adapter, ref, [{ operation }], context);
      const method = adapter[operation];
      if (!method) {
        throw new StorageError('Unsupported');
      }
      return checkedEntry(
        await method.call(adapter, ref, target, context),
        ref.connectionId,
        target.parent.spaceId,
      );
    });
  }

  private createDefaultDirectoryScope(root: EntryRef): DirectoryScope {
    const created: EntryRef[] = [];
    const findChildDirectory = async (
      parent: EntryRef,
      name: string,
      context: OperationContext,
    ): Promise<Entry | undefined> => {
      let cursor: string | undefined;
      do {
        const page = await this.list(parent, cursor ? { cursor } : {}, context);
        const match = page.entries.find((entry) => entry.name === name);
        if (match) return match;
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return undefined;
    };

    return {
      root,
      ensureDirectory: async (parent, name, { replace }, context = {}) => {
        try {
          const entry = await this.createDirectory({ parent, name }, context);
          created.push(entry.ref);
          return { entry, created: true };
        } catch (error) {
          const failure = normalizeStorageError(error);
          if (!replace || failure.code !== 'AlreadyExists') throw failure;
          const existing = await findChildDirectory(parent, name, context);
          if (!existing || existing.kind !== 'directory') throw new StorageError('InvalidArgument');
          return { entry: existing, created: false };
        }
      },
      assertValid: async (_dir, context = {}) => {
        throwIfAborted(context.signal);
      },
      cleanupCreated: async (context = {}) => {
        let failed = false;
        for (const ref of [...created].reverse()) {
          try {
            await this.remove(ref, context, { onlyIfEmpty: true });
          } catch (error) {
            const code = normalizeStorageError(error).code;
            if (code !== 'NotFound' && code !== 'PreconditionFailed') failed = true;
          }
        }
        created.length = 0;
        if (failed) throw new StorageError('OutcomeUnknown');
      },
    };
  }

  private async withConnection<T>(
    connectionId: string,
    context: OperationContext,
    run: (lease: AdapterLease) => Promise<T>,
  ): Promise<T> {
    if (typeof connectionId !== 'string' || !connectionId) {
      throw new StorageError('InvalidArgument');
    }
    const lease = await this.registry.acquire(connectionId, context);
    try {
      throwIfAborted(lease.context.signal);
      return await run(lease);
    } catch (error) {
      throw normalizeStorageError(error);
    } finally {
      lease.release();
    }
  }
}

function validateSpaceOwnership(spaces: Space[], connectionId: string): void {
  const spaceIds = new Set<string>();

  for (const space of spaces) {
    const belongsToConnection =
      space.connectionId === connectionId && space.root.connectionId === connectionId;
    const hasMatchingRoot = space.root.spaceId === space.id;
    const hasDuplicateId = spaceIds.has(space.id);

    if (!belongsToConnection || !hasMatchingRoot || hasDuplicateId) {
      throw new StorageError('OutcomeUnknown');
    }

    spaceIds.add(space.id);
  }
}

function validateReadResult(handle: ReadHandle, options: ReadOptions): void {
  const requestedLength = options.range?.length;
  if (
    requestedLength !== undefined &&
    handle.length !== undefined &&
    handle.length > requestedLength
  ) {
    throw new StorageError('OutcomeUnknown');
  }

  const expectedRevision = options.expectedRevision;
  if (
    expectedRevision !== undefined &&
    handle.revision !== undefined &&
    handle.revision !== expectedRevision
  ) {
    throw new StorageError('PreconditionFailed');
  }
}
