import { Readable } from 'node:stream';
import type { GoogleDriveAuthorization } from '../../../accounts/providers/google-drive/credential-resolver';
import type { OperationContext, ReadHandle } from '../../core/contracts';
import { StorageError, throwIfAborted } from '../../core/errors';
import { driveFailure } from './google-drive-adapter';

/** A header timeout and an inactivity timeout allow large, continuously flowing downloads. */
export async function readGoogleDriveContent(
  id: string,
  authorization: GoogleDriveAuthorization,
  request: typeof fetch,
  context: OperationContext,
): Promise<ReadHandle> {
  throwIfAborted(context.signal);
  const accessToken = await authorization.getAccessToken(context);
  throwIfAborted(context.signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  context.signal?.addEventListener('abort', abort, { once: true });
  let timeout = setTimeout(abort, 20_000);
  timeout.unref();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stream: Readable | undefined;
  let disposed = false;
  async function dispose(destroyStream = true) {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    context.signal?.removeEventListener('abort', abort);
    controller.abort();
    if (destroyStream) stream?.destroy();
    await reader?.cancel().catch(() => {});
  }
  try {
    const response = await request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
      {
        headers: { Authorization: 'Bearer ' + accessToken, 'Accept-Encoding': 'identity' },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      throw driveFailure(response.status, payload);
    }
    clearTimeout(timeout);
    if (!response.body) throw new StorageError('OutcomeUnknown');
    const encoded = response.headers.get('content-encoding');
    const lengthHeader =
      !encoded || encoded === 'identity' ? response.headers.get('content-length') : null;
    const length = lengthHeader === null ? undefined : Number(lengthHeader);
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0))
      throw new StorageError('OutcomeUnknown');
    reader = response.body.getReader();
    const bodyReader = reader;
    stream = Readable.from(
      (async function* () {
        try {
          while (true) {
            timeout = setTimeout(abort, 60_000);
            timeout.unref();
            const chunk = await bodyReader.read();
            clearTimeout(timeout);
            throwIfAborted(context.signal);
            if (chunk.done) break;
            yield chunk.value;
          }
        } catch (error) {
          throwIfAborted(context.signal);
          throw new StorageError('NetworkError', { cause: error });
        } finally {
          await dispose(false);
        }
      })(),
      { objectMode: false },
    );
    stream.on('error', () => {});
    return { stream, ...(length !== undefined ? { length } : {}), dispose: () => dispose() };
  } catch (error) {
    await dispose();
    throwIfAborted(context.signal);
    if (error instanceof StorageError) throw error;
    throw new StorageError('NetworkError', { cause: error });
  }
}
