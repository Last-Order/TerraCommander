import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { EntryRef } from '../../../shared/storage/models';
import { StorageError } from '../core/errors';
import { parse } from '../core/validation';

const cursorSchema = z.strictObject({
  version: z.literal(1),
  binding: z.string(),
  connectionId: z.string(),
  spaceId: z.string(),
  parent: z.string(),
  pageSize: z.number(),
  cursor: z.string(),
});

export class CursorCodec {
  // Instance-local signing deliberately makes cursors short-lived, unlike upload checkpoints.
  private readonly key = randomBytes(32);

  encode(ref: EntryRef, pageSize: number, binding: string, cursor: string): string {
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        binding,
        connectionId: ref.connectionId,
        spaceId: ref.spaceId,
        parent: ref.locator,
        pageSize,
        cursor,
      }),
    ).toString('base64url');
    const token = `${payload}.${this.sign(payload)}`;
    if (token.length > 65536) {
      throw new StorageError('OutcomeUnknown');
    }

    return token;
  }

  decode(token: string, ref: EntryRef, pageSize: number, binding: string): string {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) {
      throw new StorageError('InvalidArgument');
    }

    const expectedSignature = Buffer.from(this.sign(payload));
    const receivedSignature = Buffer.from(signature);
    const hasMatchingSignature =
      expectedSignature.length === receivedSignature.length &&
      timingSafeEqual(expectedSignature, receivedSignature);

    // Authenticate before decoding any caller-controlled cursor claims.
    if (!hasMatchingSignature) {
      throw new StorageError('InvalidArgument');
    }

    let input: unknown;
    try {
      input = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new StorageError('InvalidArgument');
    }
    const value = parse(cursorSchema, input);
    const matchesConnection = value.binding === binding && value.connectionId === ref.connectionId;
    const matchesParent = value.spaceId === ref.spaceId && value.parent === ref.locator;
    const matchesRequest = value.pageSize === pageSize;

    if (!matchesConnection || !matchesParent || !matchesRequest) {
      throw new StorageError('InvalidArgument');
    }

    return value.cursor;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('base64url');
  }
}
