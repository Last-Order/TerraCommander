import type {
  Capabilities,
  CapabilityScope,
  Entry,
  EntryRef,
  ReadOptions,
  StorageOperation,
  WriteTarget,
} from '../../../shared/storage/models';
import type { StorageAdapter } from '../ports/adapter';
import type { OperationContext } from './contracts';
import { StorageError, throwIfAborted } from './errors';
import { capabilitiesSchema, entrySchema, parse } from './validation';

export interface CapabilityRequirement {
  operation: StorageOperation;
  /** Unknown support is insufficient when a request depends on a specific guarantee. */
  strict?: boolean;
}

export function readRequirements(options: ReadOptions): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [{ operation: 'read' }];

  if (options.range) {
    requirements.push({ operation: 'rangeRead', strict: true });
  }
  if (options.expectedRevision !== undefined) {
    requirements.push({ operation: 'conditionalRead', strict: true });
  }

  return requirements;
}

export function writeRequirements(target: WriteTarget): CapabilityRequirement[] {
  const requirements: CapabilityRequirement[] = [{ operation: 'write' }];

  if (target.policy === 'replace-if-version') {
    requirements.push({ operation: 'conditionalWrite', strict: true });
  }

  return requirements;
}

export function targetRef(target: WriteTarget): EntryRef {
  return target.kind === 'create' ? target.parent : target.ref;
}

export function scopeConnection(scope: CapabilityScope): string {
  return scope.kind === 'entry' ? scope.ref.connectionId : scope.connectionId;
}

export function checkedEntry(input: unknown, connectionId: string, spaceId?: string): Entry {
  const entry = parse(entrySchema, input, 'OutcomeUnknown');
  if (
    entry.ref.connectionId !== connectionId ||
    (spaceId !== undefined && entry.ref.spaceId !== spaceId)
  ) {
    throw new StorageError('OutcomeUnknown');
  }
  return entry;
}

export async function getCapabilities(
  adapter: StorageAdapter,
  scope: CapabilityScope,
  ctx: OperationContext,
): Promise<Capabilities> {
  throwIfAborted(ctx.signal);
  if (scopeConnection(scope) !== adapter.connectionId) {
    throw new StorageError('InvalidArgument');
  }
  return parse(capabilitiesSchema, await adapter.capabilities(scope, ctx), 'OutcomeUnknown');
}

export async function requireCapabilities(
  adapter: StorageAdapter,
  ref: EntryRef,
  requests: CapabilityRequirement[],
  ctx: OperationContext,
): Promise<Capabilities> {
  const capabilities = await getCapabilities(adapter, { kind: 'entry', ref }, ctx);

  for (const { operation, strict } of requests) {
    const support = capabilities[operation]?.support ?? 'unknown';
    const isUnsupported = support === 'unsupported';
    const lacksRequiredGuarantee = strict && support !== 'supported';

    // Ordinary operations may defer unknown support to the adapter's authorization checks.
    if (isUnsupported || lacksRequiredGuarantee) {
      throw new StorageError('Unsupported');
    }
  }

  return capabilities;
}
