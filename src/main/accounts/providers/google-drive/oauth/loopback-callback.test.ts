import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { listenForGoogleCallback } from './loopback-callback';

function send(url: string, options: { method?: string; host?: string } = {}) {
  return new Promise<{ status: number; body: string; cacheControl: string | undefined }>(
    (resolve, reject) => {
      const outgoing = request(
        url,
        {
          method: options.method ?? 'GET',
          ...(options.host ? { headers: { Host: options.host } } : {}),
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body,
              cacheControl: response.headers['cache-control'],
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    },
  );
}

describe('Google OAuth loopback callback', () => {
  it('ignores invalid requests, accepts the matching response once, and closes its port', async () => {
    const callback = await listenForGoogleCallback('expected-state', new AbortController().signal);
    try {
      expect(new URL(callback.redirectUri).hostname).toBe('127.0.0.1');
      const invalid = [
        `${callback.redirectUri}?state=wrong&code=private-code`,
        `${callback.redirectUri}?state=expected-state&state=expected-state&code=private-code`,
        `${callback.redirectUri}?state=expected-state&code=one&code=two`,
        `${callback.redirectUri}?state=expected-state&code=one&error=`,
        `${new URL(callback.redirectUri).origin}/wrong?state=expected-state&code=private-code`,
      ];
      for (const url of invalid) expect((await send(url)).status).toBe(400);
      const validUrl = `${callback.redirectUri}?state=expected-state&code=private-code`;
      expect((await send(validUrl, { host: 'evil.test' })).status).toBe(400);
      expect((await send(validUrl, { method: 'POST' })).status).toBe(400);
      const response = await send(validUrl);
      expect(response.status).toBe(200);
      expect(response.body).not.toMatch(/private-code|expected-state/);
      expect(response.cacheControl).toBe('no-store');
      await expect(callback.code).resolves.toBe('private-code');
      expect((await send(validUrl)).status).toBe(410);
    } finally {
      await callback.close();
    }
    await expect(send(callback.redirectUri)).rejects.toThrow();
  });

  it('handles denial and cancellation without returning provider error text', async () => {
    const controller = new AbortController();
    const callback = await listenForGoogleCallback('expected-state', controller.signal);
    const denied = callback.code.catch((error: unknown) => error);
    try {
      const response = await send(
        `${callback.redirectUri}?state=expected-state&error=access_denied&error_description=private-detail`,
      );
      expect(response.body).not.toContain('private-detail');
      expect(await denied).toMatchObject({ code: 'AccessDenied' });
    } finally {
      await callback.close();
    }

    const pending = await listenForGoogleCallback('next-state', controller.signal);
    const cancelled = expect(pending.code).rejects.toMatchObject({ code: 'Cancelled' });
    controller.abort();
    await cancelled;
    await pending.close();
    await expect(send(pending.redirectUri)).rejects.toThrow();
  });

  it('refuses an already-cancelled attempt before opening a port', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(listenForGoogleCallback('unused-state', controller.signal)).rejects.toMatchObject({
      code: 'Cancelled',
    });
  });
});
