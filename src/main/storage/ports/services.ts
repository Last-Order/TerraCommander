import type { OperationContext } from '../core/contracts';

export interface CredentialResolver {
  /** Returns adapter-specific authorization that stays in the backend. */
  resolve(reference: string, ctx: OperationContext): Promise<unknown>;
}

export interface StorageLogger {
  event(name: string, fields: Readonly<Record<string, string | number | boolean>>): void;
}

/** Backend-only persistence boundary; the host supplies durable, confidential storage. */
export interface CheckpointStore {
  /** Returns undefined when no checkpoint exists. Stored data is revalidated on load. */
  load(id: string): Promise<unknown>;
  /** Resolves after atomic durable replacement; drivers cannot continue before this resolves. */
  save(id: string, checkpoint: unknown): Promise<void>;
}
