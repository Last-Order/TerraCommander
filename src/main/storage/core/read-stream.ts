import { Readable } from 'node:stream';
import type { OperationContext, ReadHandle } from './contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from './errors';
import { byteCountSchema, parse } from './validation';

/** Owns a provider handle until EOF, cancellation, or explicit disposal releases its lease. */
export function managedRead(
  providerHandle: ReadHandle,
  context: OperationContext,
  releaseLease: () => void = () => {},
  emitProgress = true,
): ReadHandle {
  if (
    !(providerHandle.stream instanceof Readable) ||
    typeof providerHandle.dispose !== 'function'
  ) {
    throw new StorageError('OutcomeUnknown');
  }
  if (providerHandle.length !== undefined) {
    parse(byteCountSchema, providerHandle.length, 'OutcomeUnknown');
  }

  let cleanupPromise: Promise<void> | undefined;
  let processedBytes = 0;
  const stream = Readable.from(readChunks(), { objectMode: false, highWaterMark: 65536 });
  // Consumers may attach later; cancellation must never cause an unhandled error event.
  stream.on('error', () => {});
  providerHandle.stream.on('error', forwardError);
  providerHandle.stream.once('close', () =>
    providerHandle.stream.removeListener('error', forwardError),
  );

  function forwardError(error: unknown): void {
    stream.destroy(normalizeStorageError(error));
  }

  async function* readChunks() {
    try {
      for await (const chunk of providerHandle.stream) {
        throwIfAborted(context.signal);
        if (!(chunk instanceof Uint8Array)) {
          throw new StorageError('OutcomeUnknown');
        }
        processedBytes += chunk.byteLength;
        parse(byteCountSchema, processedBytes, 'OutcomeUnknown');
        if (providerHandle.length !== undefined && processedBytes > providerHandle.length) {
          throw new StorageError('OutcomeUnknown');
        }
        if (emitProgress) {
          context.onProgress?.({
            processedBytes,
            ...(providerHandle.length !== undefined ? { totalBytes: providerHandle.length } : {}),
          });
        }

        yield chunk;
      }
      if (providerHandle.length !== undefined && processedBytes !== providerHandle.length) {
        throw new StorageError('OutcomeUnknown');
      }
    } catch (error) {
      throw normalizeStorageError(error);
    } finally {
      await releaseResources();
    }
  }

  function releaseResources(): Promise<void> {
    // EOF, explicit disposal, and cancellation can race. Provider cleanup runs exactly once.
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = Promise.resolve().then(async () => {
      context.signal?.removeEventListener('abort', abort);
      providerHandle.stream.destroy();
      try {
        await providerHandle.dispose();
      } catch (error) {
        throw normalizeStorageError(error);
      } finally {
        if (providerHandle.stream.closed) {
          providerHandle.stream.removeListener('error', forwardError);
        }
        releaseLease();
      }
    });
    return cleanupPromise;
  }

  function abort(): void {
    stream.destroy(new StorageError('Cancelled'));
    void releaseResources().catch(() => {});
  }

  function dispose(): Promise<void> {
    // Natural EOF only releases provider resources; explicit disposal also ends the public stream.
    if (!stream.destroyed) {
      stream.destroy(new StorageError('Cancelled'));
    }
    return releaseResources();
  }

  stream.once('close', () => {
    void releaseResources().catch(() => {});
  });
  context.signal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) {
    abort();
  }

  return {
    stream,
    ...(providerHandle.length !== undefined ? { length: providerHandle.length } : {}),
    ...(providerHandle.revision !== undefined ? { revision: providerHandle.revision } : {}),
    dispose,
  };
}
