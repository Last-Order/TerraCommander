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
  Space,
  WriteTarget,
} from '../../../shared/storage/models';
import type { ByteSource, OperationContext, ReadHandle, UploadDriver } from '../core/contracts';
import type { CredentialResolver, StorageLogger } from './services';

/** Native storage semantics stay inside the adapter; unsupported operations remain optional. */
export interface StorageAdapter {
  readonly connectionId: string;
  readonly uploads?: UploadDriver;
  listSpaces(ctx: OperationContext): Promise<Space[]>;
  stat(ref: EntryRef, ctx: OperationContext): Promise<Entry>;
  /** A snapshot of effective support, not a substitute for authorization during execution. */
  capabilities(scope: CapabilityScope, ctx: OperationContext): Promise<Capabilities>;
  list?(parent: EntryRef, request: ListRequest, ctx: OperationContext): Promise<EntryPage>;
  read?(ref: EntryRef, options: ReadOptions, ctx: OperationContext): Promise<ReadHandle>;
  write?(target: WriteTarget, source: ByteSource, ctx: OperationContext): Promise<Entry>;
  createDirectory?(target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  remove?(ref: EntryRef, ctx: OperationContext): Promise<void>;
  copyWithin?(ref: EntryRef, target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  moveWithin?(ref: EntryRef, target: CreateTarget, ctx: OperationContext): Promise<Entry>;
  dispose(): Promise<void>;
}

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
