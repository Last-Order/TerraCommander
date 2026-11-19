import type { CredentialResolver } from '../../common/credentials';
import type { StructuredLogger } from '../../common/logger';

export type { CredentialResolver };
export type StorageLogger = StructuredLogger;

/** Backend-only persistence boundary; the host supplies durable, confidential storage. */
export interface CheckpointStore {
  /** Returns undefined when no checkpoint exists. Stored data is revalidated on load. */
  load(id: string): Promise<unknown>;
  /** Resolves after atomic durable replacement; drivers cannot continue before this resolves. */
  save(id: string, checkpoint: unknown): Promise<void>;
}
