import type { OperationContext } from './operation-context';

export interface CredentialResolver {
  /** Returns adapter-specific authorization that stays in the backend. */
  resolve(reference: string, ctx: OperationContext): Promise<unknown>;
}
