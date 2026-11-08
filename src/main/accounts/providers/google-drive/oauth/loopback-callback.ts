import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fallbackLanguage, type AppLanguage } from '../../../../../shared/language';
import { nativeMessages } from '../../../../native-messages';
import { assertNotCancelled, AccountError } from '../../../core/errors';
import type { AuthorizationCallback } from '../ports';

const CALLBACK_PATH = '/oauth2/callback';
const RESPONSE_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  Connection: 'close',
};

function matchesState(candidate: string, expected: string): boolean {
  const received = Buffer.from(candidate);
  const original = Buffer.from(expected);
  return received.length === original.length && timingSafeEqual(received, original);
}

function respond(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, RESPONSE_HEADERS);
  response.end(text);
}

/** A short-lived listener restricted to this machine, not a general-purpose local web server. */
export async function listenForGoogleCallback(
  state: string,
  signal: AbortSignal,
  getLanguage: () => AppLanguage = () => fallbackLanguage,
): Promise<AuthorizationCallback> {
  assertNotCancelled(signal);
  let origin = '';
  let consumed = false;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: unknown) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Abort can arrive while the caller is still opening the browser.
  void code.catch(() => undefined);

  const server = createServer({ maxHeaderSize: 8192 }, handleCallback);
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.unref();

  function fail(error: AccountError): void {
    if (settled) return;
    settled = true;
    rejectCode(error);
  }

  function handleCallback(request: IncomingMessage, response: ServerResponse): void {
    const messages = nativeMessages[getLanguage()];
    if (consumed) {
      respond(response, 410, messages.callbackDuplicate);
      return;
    }
    if (
      request.method !== 'GET' ||
      request.headers.host !== origin.slice('http://'.length) ||
      !request.url?.startsWith('/') ||
      request.url.startsWith('//') ||
      request.url.length > 8192
    ) {
      respond(response, 400, messages.callbackInvalid);
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url, origin);
    } catch {
      respond(response, 400, messages.callbackInvalid);
      return;
    }
    const query = url.searchParams;
    const receivedState = query.get('state');
    const authorizationCode = query.get('code');
    const authorizationError = query.get('error');
    const ambiguous = ['state', 'code', 'error'].some((key) => query.getAll(key).length > 1);
    if (
      url.origin !== origin ||
      url.pathname !== CALLBACK_PATH ||
      ambiguous ||
      !receivedState ||
      !matchesState(receivedState, state) ||
      query.has('code') === query.has('error') ||
      (query.has('code') && !authorizationCode) ||
      (query.has('error') && !authorizationError)
    ) {
      // Invalid requests do not consume the attempt; a valid browser response can still arrive.
      respond(response, 400, messages.callbackInvalid);
      return;
    }

    consumed = true;
    if (authorizationError) {
      fail(
        new AccountError(
          authorizationError === 'admin_policy_enforced' ? 'AccessBlocked' : 'AccessDenied',
        ),
      );
      respond(response, 200, messages.callbackIncomplete);
    } else {
      settled = true;
      resolveCode(authorizationCode!);
      respond(response, 200, messages.callbackReceived);
    }
  }

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    fail(new AccountError('Cancelled'));
    signal.removeEventListener('abort', onAbort);
    closing = new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  }
  function onAbort(): void {
    try {
      assertNotCancelled(signal);
    } catch (error) {
      if (error instanceof AccountError) fail(error);
    }
    void close();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    server.on('error', () => fail(new AccountError('NetworkError')));
    const address = server.address();
    if (!address || typeof address === 'string') throw new AccountError('NetworkError');
    origin = `http://127.0.0.1:${address.port}`;
    signal.addEventListener('abort', onAbort, { once: true });
    assertNotCancelled(signal);
    return { redirectUri: `${origin}${CALLBACK_PATH}`, code, close };
  } catch (error) {
    await close();
    assertNotCancelled(signal);
    throw new AccountError('NetworkError', error);
  }
}
