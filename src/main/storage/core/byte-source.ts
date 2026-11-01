import type { ByteRange } from '../../../shared/storage/models';
import type { ByteSource, OperationContext, ReadHandle, ReopenableByteSource } from './contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from './errors';
import { managedRead } from './read-stream';
import { byteCountSchema, parse, rangeSchema, sourceDescriptorSchema } from './validation';

interface ByteSourceScope {
  source: ByteSource;
  dispose(): Promise<void>;
}

/** Tracks every stream a driver opens so failure or cancellation can close them together. */
export function scopeSource(source: ByteSource, context: OperationContext): ByteSourceScope {
  validateSource(source);

  const openHandles = new Set<ReadHandle>();
  let hasOpened = false;
  let isDisposed = false;

  async function open(
    range: ByteRange | undefined,
    requestContext: OperationContext,
  ): Promise<ReadHandle> {
    if (isDisposed) {
      throw new StorageError('PreconditionFailed');
    }
    throwIfAborted(context.signal);
    validateSourceRange(source, range, hasOpened);
    hasOpened = true;

    const readContext = combineCancellation(context, requestContext);
    throwIfAborted(readContext.signal);
    const providerHandle = await source.open(range, readContext);

    let managedHandle: ReadHandle;
    try {
      managedHandle = managedRead(
        providerHandle,
        readContext,
        () => openHandles.delete(managedHandle),
        false,
      );
    } catch (error) {
      await providerHandle.dispose().catch(() => undefined);
      throw normalizeStorageError(error);
    }

    openHandles.add(managedHandle);

    // The scope can close while source.open is pending; reclaim that late resource too.
    if (isDisposed || readContext.signal?.aborted) {
      await managedHandle.dispose();
      throw new StorageError('Cancelled');
    }

    return managedHandle;
  }

  async function dispose(): Promise<void> {
    isDisposed = true;
    const results = await Promise.allSettled([...openHandles].map((handle) => handle.dispose()));
    const failure = results.find((result) => result.status === 'rejected');

    if (failure?.status === 'rejected') {
      throw normalizeStorageError(failure.reason);
    }
  }

  return { source: wrapSource(source, open), dispose };
}

function validateSource(source: ByteSource): void {
  if (source.kind !== 'one-shot' && source.kind !== 'reopenable') {
    throw new StorageError('InvalidArgument');
  }
  if (typeof source.open !== 'function') {
    throw new StorageError('InvalidArgument');
  }
  if (source.size !== undefined) {
    parse(byteCountSchema, source.size);
  }
  if (source.kind === 'reopenable') {
    const descriptor = parse(sourceDescriptorSchema, source.descriptor);
    if (source.size !== undefined && source.size !== descriptor.size) {
      throw new StorageError('InvalidArgument');
    }
  }
}

function validateSourceRange(
  source: ByteSource,
  range: ByteRange | undefined,
  hasOpened: boolean,
): void {
  if (range !== undefined) {
    parse(rangeSchema, range);
  }
  if (source.kind === 'one-shot' && (hasOpened || range !== undefined)) {
    throw new StorageError('Unsupported');
  }

  const sourceSize = source.kind === 'reopenable' ? source.descriptor.size : source.size;
  if (!range || sourceSize === undefined) {
    return;
  }

  const startsPastEnd = range.offset > sourceSize;
  const endsPastEnd = range.length !== undefined && range.offset + range.length > sourceSize;
  if (startsPastEnd || endsPastEnd) {
    throw new StorageError('InvalidArgument');
  }
}

function combineCancellation(
  context: OperationContext,
  request: OperationContext,
): OperationContext {
  const signals = [context.signal, request.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  return { ...context, signal: AbortSignal.any(signals) };
}

function wrapSource(source: ByteSource, open: ByteSource['open']): ByteSource {
  const size = source.size !== undefined ? { size: source.size } : {};

  if (source.kind === 'one-shot') {
    return { kind: 'one-shot', ...size, open };
  }

  const wrappedSource: ReopenableByteSource = {
    kind: 'reopenable',
    descriptor: structuredClone(source.descriptor),
    open,
    ...size,
  };

  if (source.verify) {
    wrappedSource.verify = (expected, context) => source.verify!(expected, context);
  }

  return wrappedSource;
}

/** Weak metadata needs an independent proof; matching names or sizes alone cannot prove identity. */
export async function verifySource(
  source: ReopenableByteSource,
  expected: ReopenableByteSource['descriptor'],
  context: OperationContext,
): Promise<void> {
  const actual = parse(sourceDescriptorSchema, source.descriptor);
  const matchesDescriptor =
    actual.identity === expected.identity &&
    actual.revision === expected.revision &&
    actual.size === expected.size &&
    actual.verification === expected.verification;

  if (!matchesDescriptor) {
    throw new StorageError('SourceChanged');
  }

  const failedVerification = source.verify && !(await source.verify(expected, context));
  const lacksRequiredProof = expected.verification === 'weak' && !source.verify;
  if (failedVerification || lacksRequiredProof) {
    throw new StorageError('ResumeInvalid');
  }

  throwIfAborted(context.signal);
}
