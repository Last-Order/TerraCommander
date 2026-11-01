import type { ConnectionDefinition } from '../../../shared/storage/models';
import type { OperationContext } from '../core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '../core/errors';
import { connectionSchema, fingerprint, parse } from '../core/validation';
import type { AdapterFactory, AdapterServices, StorageAdapter } from '../ports/adapter';

interface ConnectionRecord {
  definition: ConnectionDefinition;
  fingerprint: string;
  lifetimeController: AbortController;
  creationPromise: Promise<StorageAdapter>;
  adapter?: StorageAdapter;
  isClosing: boolean;
  disposalPromise?: Promise<void>;
  activeLeases: Set<symbol>;
  onLeasesDrained?: () => void;
}

/** An operation owns its lease until it finishes; a read stream owns it until disposal. */
export interface AdapterLease {
  adapter: StorageAdapter;
  context: OperationContext;
  definition: ConnectionDefinition;
  fingerprint: string;
  release(): void;
}

/** Owns adapter instances and ensures shutdown waits for their outstanding operations. */
export class AdapterRegistry {
  private readonly factories = new Map<string, AdapterFactory>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly connectionBindings = new Map<string, string>();
  private isDisposed = false;

  constructor(private readonly services: AdapterServices) {}

  register(factory: AdapterFactory): void {
    this.assertOpen();

    if (
      typeof factory.provider !== 'string' ||
      !factory.provider ||
      typeof factory.create !== 'function'
    ) {
      throw new StorageError('InvalidArgument');
    }
    if (this.factories.has(factory.provider)) {
      throw new StorageError('AlreadyExists');
    }

    this.factories.set(factory.provider, factory);
  }

  async connect(input: ConnectionDefinition, context: OperationContext = {}): Promise<void> {
    this.assertOpen();
    throwIfAborted(context.signal);

    const parsed = parse(connectionSchema, input);
    const definition: ConnectionDefinition = {
      id: parsed.id,
      provider: parsed.provider,
      configuration: parsed.configuration,
      ...(parsed.credentialRef !== undefined ? { credentialRef: parsed.credentialRef } : {}),
    };
    const factory = this.factories.get(definition.provider);

    if (!factory) {
      throw new StorageError('Unsupported');
    }
    if (this.connections.has(definition.id)) {
      throw new StorageError('AlreadyExists');
    }

    const binding = fingerprint(definition);
    const previousBinding = this.connectionBindings.get(definition.id);
    if (previousBinding !== undefined && previousBinding !== binding) {
      throw new StorageError('PreconditionFailed');
    }

    const record = this.createConnectionRecord(definition, binding, factory, context);
    this.connections.set(definition.id, record);

    try {
      await record.creationPromise;
      if (record.isClosing) {
        throw new StorageError('Cancelled');
      }

      // Retain the binding after disconnect so old references cannot identify another account.
      this.connectionBindings.set(definition.id, binding);
    } catch (error) {
      await this.closeConnection(record);
      throw normalizeStorageError(error);
    }
  }

  async acquire(connectionId: string, context: OperationContext = {}): Promise<AdapterLease> {
    this.assertOpen();
    throwIfAborted(context.signal);

    const record = this.connections.get(connectionId);
    if (!record || record.isClosing) {
      throw new StorageError('NotFound');
    }

    let adapter: StorageAdapter;
    try {
      adapter = await record.creationPromise;
    } catch (error) {
      throw normalizeStorageError(error);
    }

    if (record.isClosing) {
      throw new StorageError('Cancelled');
    }
    throwIfAborted(context.signal);

    const leaseId = Symbol();
    record.activeLeases.add(leaseId);

    return {
      adapter,
      context: connectionContext(context, record.lifetimeController.signal),
      definition: structuredClone(record.definition),
      fingerprint: record.fingerprint,
      release: () => {
        // Set deletion makes repeated release harmless, including stream-close races.
        record.activeLeases.delete(leaseId);
        if (record.activeLeases.size === 0) {
          record.onLeasesDrained?.();
        }
      },
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    const record = this.connections.get(connectionId);
    if (!record) {
      throw new StorageError('NotFound');
    }

    await this.closeConnection(record);
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    const results = await Promise.allSettled(
      [...this.connections.values()].map((record) => this.closeConnection(record)),
    );
    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') {
      throw normalizeStorageError(failure.reason);
    }
  }

  private createConnectionRecord(
    definition: ConnectionDefinition,
    binding: string,
    factory: AdapterFactory,
    context: OperationContext,
  ): ConnectionRecord {
    const lifetimeController = new AbortController();
    const creationContext = connectionContext(context, lifetimeController.signal);
    const record: ConnectionRecord = {
      definition,
      fingerprint: binding,
      lifetimeController,
      isClosing: false,
      activeLeases: new Set(),

      // Defer factory work until connect has reserved the ID in the connections map.
      creationPromise: Promise.resolve().then(() =>
        this.createAdapter(record, factory, creationContext),
      ),
    };

    return record;
  }

  private async createAdapter(
    record: ConnectionRecord,
    factory: AdapterFactory,
    context: OperationContext,
  ): Promise<StorageAdapter> {
    throwIfAborted(context.signal);
    const adapter = await factory.create(
      structuredClone(record.definition),
      this.services,
      context,
    );

    // Save even a late result so cancellation can still dispose its resources.
    record.adapter = adapter;
    if (adapter.connectionId !== record.definition.id || typeof adapter.dispose !== 'function') {
      throw new StorageError('OutcomeUnknown');
    }

    throwIfAborted(context.signal);
    return adapter;
  }

  private closeConnection(record: ConnectionRecord): Promise<void> {
    if (record.disposalPromise) {
      return record.disposalPromise;
    }

    // Reject new leases immediately; concurrent disconnect calls share the same cleanup.
    record.isClosing = true;
    record.disposalPromise = Promise.resolve().then(async () => {
      record.lifetimeController.abort();

      try {
        // Creation errors belong to connect; cleanup must still handle a late adapter result.
        await record.creationPromise.catch(() => undefined);

        if (record.activeLeases.size > 0) {
          await new Promise<void>((resolve) => {
            record.onLeasesDrained = resolve;
          });
        }

        if (typeof record.adapter?.dispose === 'function') {
          await record.adapter.dispose();
        }
      } catch (error) {
        throw normalizeStorageError(error);
      } finally {
        if (this.connections.get(record.definition.id) === record) {
          this.connections.delete(record.definition.id);
        }
      }
    });

    return record.disposalPromise;
  }

  private assertOpen(): void {
    if (this.isDisposed) {
      throw new StorageError('PreconditionFailed');
    }
  }
}

function connectionContext(
  context: OperationContext,
  lifetimeSignal: AbortSignal,
): OperationContext {
  const signal = context.signal
    ? AbortSignal.any([context.signal, lifetimeSignal])
    : lifetimeSignal;

  return { ...context, signal };
}
