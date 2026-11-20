import { normalizeStorageError } from '@main/storage/core/errors';
import type { StorageLogger } from '@main/storage/ports/services';

const networkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EACCES',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Only fixed diagnostic fields leave the backend; causes can contain tokens and signed URLs. */
export function logGoogleDriveFailure(
  logger: StorageLogger,
  error: unknown,
  details: {
    stage: 'metadata' | 'headers' | 'body';
    timedOut: boolean;
    rangeRequested?: boolean;
    status?: number;
  },
): void {
  const failure = normalizeStorageError(error);
  if (failure.code === 'Cancelled') return;
  let networkCode: string | undefined;
  let cause = error;
  for (let depth = 0; depth < 8 && cause && typeof cause === 'object'; depth++) {
    if ('code' in cause && typeof cause.code === 'string' && networkCodes.has(cause.code)) {
      networkCode = cause.code;
      break;
    }
    if (cause instanceof Error && cause.message === 'unexpected redirect') {
      networkCode = 'UnexpectedRedirect';
      break;
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  try {
    logger.event('google-drive.request.failed', {
      ...details,
      errorCode: failure.code,
      ...(networkCode ? { networkCode } : {}),
    });
  } catch {
    /* Diagnostics must not replace the request failure or interrupt cleanup. */
  }
}
