import { createHash } from 'node:crypto';
import type {
  AdapterWriteSession,
  OperationContext,
  ReopenableByteSource,
  SessionWriteContext,
} from '@main/storage/core/contracts';
import { normalizeStorageError, StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { Entry } from '@shared/storage';
import type { GoogleDriveAuthorization } from './authorization';
import { driveFailure } from './google-drive-errors';

const uploadEndpoint = new URL('https://www.googleapis.com/upload/drive/v3/files');
const chunkSize = 8 * 1024 * 1024;

interface DriveUpload {
  id: string;
  name: string;
  parentId: string;
  fields: string;
  size: number;
  complete(payload: unknown): Entry;
  reconcile(context: OperationContext): Promise<Entry>;
}

export function createGoogleDriveWriteSession(
  upload: DriveUpload,
  authorization: GoogleDriveAuthorization,
  request: typeof fetch,
): AdapterWriteSession {
  const { size } = upload;
  const endpoint = new URL(uploadEndpoint);
  endpoint.search = new URLSearchParams({
    uploadType: 'resumable',
    supportsAllDrives: 'true',
    fields: upload.fields,
  }).toString();
  let session: URL | undefined;
  let confirmed = 0;
  let prefix = createHash('sha256');
  let pending: { end: number; digest: string } | undefined;
  let mayHaveCommitted = false;

  async function send(url: URL, init: RequestInit, operation: OperationContext) {
    throwIfAborted(operation.signal);
    const token = await authorization.getAccessToken(operation).catch((error: unknown) => {
      throwIfAborted(operation.signal);
      throw error;
    });
    throwIfAborted(operation.signal);
    const timeout = AbortSignal.timeout(60_000);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    try {
      const options = {
        ...init,
        headers,
        duplex: 'half' as const,
        redirect: 'manual' as const,
        signal: operation.signal ? AbortSignal.any([operation.signal, timeout]) : timeout,
      };
      const response = await request(url, options);
      const payload: unknown = await response.json().catch(() => undefined);
      if (response.status >= 500 || timeout.aborted) throw new StorageError('NetworkError');
      return { response, payload };
    } catch (error) {
      throwIfAborted(operation.signal);
      throw new StorageError('NetworkError', { cause: error });
    }
  }

  async function openSession(context: OperationContext) {
    const start = await send(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'application/octet-stream',
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ id: upload.id, name: upload.name, parents: [upload.parentId] }),
      },
      context,
    );
    if (!start.response.ok) throw driveFailure(start.response.status, start.payload);
    return sessionUrl(start.response.headers.get('Location'));
  }

  function probe(url: URL, context: OperationContext) {
    return send(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
      },
      context,
    );
  }

  function resetSession() {
    session = undefined;
    confirmed = 0;
    pending = undefined;
    prefix = createHash('sha256');
  }

  function inspect({ response, payload }: Awaited<ReturnType<typeof send>>, end: number) {
    if (response.ok) {
      mayHaveCommitted = true;
      return { entry: upload.complete(payload) };
    }
    if (response.status !== 308) {
      mayHaveCommitted ||= response.status === 409 || (end === size && response.status === 404);
      if (response.status === 404) {
        resetSession();
        throw new StorageError('ResumeExpired', { retryHint: 'safe' });
      }
      throw driveFailure(response.status, payload);
    }
    const offset = confirmedOffset(response.headers.get('Range'));
    if (offset < confirmed || offset > end || (offset === size && size > 0)) {
      mayHaveCommitted ||= end === size;
      throw new StorageError('OutcomeUnknown');
    }
    return { offset };
  }

  function acknowledge(offset: number, bytes: Uint8Array) {
    prefix.update(bytes.subarray(0, offset - confirmed));
    confirmed = offset;
    pending = undefined;
  }

  function reportProgress(
    onProgress: SessionWriteContext['onProgress'],
    processed: number,
    acknowledged: number,
  ) {
    try {
      onProgress?.({
        processedBytes: processed,
        confirmedBytes: acknowledged,
        totalBytes: size,
      });
    } catch {
      /* Progress is an observation of the write. */
    }
  }

  async function resumeSession(
    url: URL,
    source: ReopenableByteSource,
    transfer: OperationContext,
    onProgress: SessionWriteContext['onProgress'],
  ): Promise<Entry | undefined> {
    const status = inspect(await probe(url, transfer), pending?.end ?? confirmed);
    if (status.entry) return status.entry;
    mayHaveCommitted = false;
    if (pending) {
      const bytes = await readChunk(source, confirmed, pending.end - confirmed, transfer);
      if (chunkDigest(bytes) !== pending.digest) throw new StorageError('SourceChanged');
      acknowledge(status.offset, bytes);
    }
    if (confirmed > 0) {
      await verifyPrefix(source, confirmed, prefix.copy().digest('hex'), transfer);
    }
    reportProgress(onProgress, confirmed, confirmed);
    return undefined;
  }

  async function uploadNextChunk(
    url: URL,
    source: ReopenableByteSource,
    transfer: OperationContext,
    finalContext: OperationContext,
    onBytesSent?: (count: number) => void,
  ) {
    const length = Math.min(chunkSize, size - confirmed);
    const end = confirmed + length;
    const final = end === size;
    const requestContext = final ? finalContext : transfer;
    const bytes = await readChunk(source, confirmed, length, transfer);
    throwIfAborted(transfer.signal);
    pending = { end, digest: chunkDigest(bytes) };

    const reply = await send(
      url,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(length),
          'Content-Range': length === 0 ? 'bytes */0' : `bytes ${confirmed}-${end - 1}/${size}`,
        },
        body: length > 0 && onBytesSent ? streamBody(bytes, onBytesSent) : bytes,
      },
      requestContext,
    ).catch((error: unknown) => {
      const code = normalizeStorageError(error).code;
      mayHaveCommitted ||= final && (code === 'NetworkError' || code === 'Cancelled');
      if (code !== 'NetworkError') throw error;
      return probe(url, requestContext);
    });

    const status = inspect(reply, end);
    return { status, bytes, end };
  }

  async function recoverFailure(
    error: unknown,
    context: {
      signal?: AbortSignal | undefined;
      pauseSignal?: AbortSignal | undefined;
      transferSignal?: AbortSignal | undefined;
      commitContext: OperationContext;
      onProgress: SessionWriteContext['onProgress'];
    },
  ): Promise<Entry> {
    const failure = normalizeStorageError(error);
    if (context.transferSignal?.aborted && failure.code === 'Cancelled') {
      const pausedOnly = Boolean(context.pauseSignal?.aborted && !context.signal?.aborted);
      if (pausedOnly && mayHaveCommitted && session) {
        const status = await probe(session, context.commitContext)
          .then((reply) => inspect(reply, pending?.end ?? confirmed))
          .catch(() => undefined);
        if (status?.entry) return status.entry;
        if (!status) return reconcile(context.commitContext);
        reportProgress(context.onProgress, status.offset, status.offset);
      }
      throw error;
    }
    if (mayHaveCommitted) return reconcile(context.commitContext);
    throwIfAborted(context.transferSignal);
    if (failure.code === 'NetworkError' || failure.code === 'AuthRequired') {
      throw new StorageError(failure.code, { retryHint: 'safe', cause: failure });
    }
    throw error;
  }

  async function run(source: ReopenableByteSource, context: SessionWriteContext): Promise<Entry> {
    const { signal, pauseSignal, ...commitContext } = context;
    const transfer = pauseSignal
      ? { ...context, signal: signal ? AbortSignal.any([signal, pauseSignal]) : pauseSignal }
      : context;
    const finalContext = pauseSignal ? transfer : commitContext;
    const complete = (entry: Entry) => {
      reportProgress(context.onProgress, size, size);
      return entry;
    };

    try {
      if (!session) {
        session = await openSession(transfer);
      } else {
        const existing = await resumeSession(session, source, transfer, context.onProgress);
        if (existing) return complete(existing);
      }

      const url = session;
      let stalled = false;
      for (;;) {
        const { status, bytes, end } = await uploadNextChunk(
          url,
          source,
          transfer,
          finalContext,
          context.onBytesSent,
        );
        if (status.entry) return complete(status.entry);
        if (status.offset === confirmed && stalled) throw new StorageError('NetworkError');
        stalled = status.offset === confirmed;
        acknowledge(status.offset, bytes);
        reportProgress(context.onProgress, end, confirmed);
      }
    } catch (error) {
      const recovered = await recoverFailure(error, {
        signal,
        pauseSignal,
        transferSignal: transfer.signal,
        commitContext,
        onProgress: context.onProgress,
      });
      return complete(recovered);
    }
  }

  async function reconcile(context: OperationContext) {
    return upload.reconcile(context).catch(() => {
      throw new StorageError('OutcomeUnknown');
    });
  }
  return { run };
}

function streamBody(bytes: Uint8Array<ArrayBuffer>, onBytesSent: (count: number) => void) {
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        controller.enqueue(chunk);
        offset += chunk.length;
        onBytesSent(chunk.length);
        if (offset === bytes.length) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

function chunkDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyPrefix(
  source: ReopenableByteSource,
  length: number,
  expected: string,
  context: OperationContext,
) {
  const handle = await source.open({ offset: 0, length }, context);
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.stream) {
      if (!(chunk instanceof Uint8Array)) throw new StorageError('SourceChanged');
      hash.update(chunk);
    }
    if (hash.digest('hex') !== expected) throw new StorageError('SourceChanged');
  } finally {
    await handle.dispose();
  }
}

function sessionUrl(location: string | null): URL {
  const url = location ? URL.parse(location) : null;
  if (
    !url ||
    url.origin !== uploadEndpoint.origin ||
    url.pathname !== uploadEndpoint.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get('upload_id')
  ) {
    throw new StorageError('OutcomeUnknown');
  }
  return url;
}

function confirmedOffset(range: string | null): number {
  if (range === null) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = Number(match?.[1]) + 1;
  if (!Number.isSafeInteger(offset)) throw new StorageError('OutcomeUnknown');
  return offset;
}

async function readChunk(
  source: ReopenableByteSource,
  offset: number,
  length: number,
  context: OperationContext,
): Promise<Uint8Array<ArrayBuffer>> {
  // An empty file still opens the source to validate that it has not changed.
  const handle = await source.open(length > 0 ? { offset, length } : undefined, context);
  const bytes = new Uint8Array(length);
  let read = 0;
  try {
    for await (const chunk of handle.stream) {
      if (!(chunk instanceof Uint8Array) || chunk.length > length - read) {
        throw new StorageError('SourceChanged');
      }
      bytes.set(chunk, read);
      read += chunk.length;
    }
    if (read !== length) throw new StorageError('SourceChanged');
    return bytes;
  } finally {
    await handle.dispose();
  }
}
