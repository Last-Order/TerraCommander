import type {
  Capabilities,
  CapabilityScope,
  ConnectionDefinition,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
  RemoveOptions,
  Space,
  SourceDescriptor,
  WriteTarget,
} from '@shared/storage/models';
import type {
  AdapterWriteSession,
  ByteSource,
  DirectoryScope,
  OperationContext,
  ReadHandle,
  UploadDriver,
  WriteOptions,
} from '../core/contracts';
import type { CredentialResolver, StorageLogger } from './services';

/** Core lifecycle and metadata port required by every storage adapter. */
export interface CoreStorageAdapter {
  readonly connectionId: string;
  listSpaces(ctx: OperationContext): Promise<Space[]>;
  stat(ref: EntryRef, ctx: OperationContext): Promise<Entry>;
  /** A snapshot of effective support, not a substitute for authorization during execution. */
  capabilities(scope: CapabilityScope, ctx: OperationContext): Promise<Capabilities>;
  /** Returns locators from the entry itself up to its space root, if discoverable. */
  ancestorLocators?(ref: EntryRef, ctx: OperationContext): Promise<readonly string[]>;
  dispose(): Promise<void>;
}

export interface ListableAdapter {
  list?(parent: EntryRef, request: ListRequest, ctx: OperationContext): Promise<EntryPage>;
}

export interface ReadableAdapter {
  read?(ref: EntryRef, options: ReadOptions, ctx: OperationContext): Promise<ReadHandle>;
}

export interface WritableAdapter {
  readonly uploads?: UploadDriver;
  write?(
    target: WriteTarget,
    source: ByteSource,
    ctx: OperationContext,
    options?: WriteOptions,
  ): Promise<Entry>;
  prepareWrite?(
    target: WriteTarget,
    source: SourceDescriptor,
    ctx: OperationContext,
    options?: WriteOptions,
  ): Promise<AdapterWriteSession>;
  createDirectory?(target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  openDirectoryScope?(root: EntryRef, ctx: OperationContext): Promise<DirectoryScope>;
}

export interface MutableAdapter {
  remove?(ref: EntryRef, ctx: OperationContext, options?: RemoveOptions): Promise<void>;
  copyWithin?(ref: EntryRef, target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  moveWithin?(ref: EntryRef, target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  rename?(ref: EntryRef, name: string, ctx: OperationContext): Promise<Entry>;
}

/** Native storage semantics stay inside the adapter; unsupported operations remain optional. */
export interface StorageAdapter
  extends CoreStorageAdapter, ListableAdapter, ReadableAdapter, WritableAdapter, MutableAdapter {}

export interface AdapterServices {
  credentials: CredentialResolver;
  logger: StorageLogger;
}

export interface AdapterFactory {
  readonly provider: string;
  /** The registry reserves the connection ID and disposes any result that arrives after cancellation. */
  create(
    connection: ConnectionDefinition,
    services: AdapterServices,
    ctx: OperationContext,
  ): Promise<StorageAdapter>;
}
