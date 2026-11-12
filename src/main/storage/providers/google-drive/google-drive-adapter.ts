import { z } from 'zod';
import type { Entry, EntryPage, EntryRef, ListRequest, Space } from '../../../../shared/storage';
import {
  matchesGoogleDriveAuthorization,
  type GoogleDriveAuthorization,
} from '../../../accounts/providers/google-drive/credential-resolver';
import type { OperationContext } from '../../core/contracts';
import { StorageError, throwIfAborted } from '../../core/errors';
import { parse } from '../../core/validation';
import type { AdapterFactory, StorageAdapter } from '../../ports/adapter';

const myDriveId = 'my-drive';
const sharedPrefix = 'shared:';
const listSupported = { list: { support: 'supported' } } as const;
const identifier = z.string().regex(/^[A-Za-z0-9_-]+$/);
const token = z.string().min(1);
const fileFields = 'id,name,mimeType,driveId,trashed,size,modifiedTime,capabilities(canRename)';
const fileSchema = z.object({
  id: identifier,
  name: z.string(),
  mimeType: token,
  driveId: identifier.optional(),
  trashed: z.boolean().optional(),
  size: z.string().regex(/^\d+$/).optional(),
  modifiedTime: z.iso.datetime({ offset: true }).optional(),
  capabilities: z.object({ canRename: z.boolean().optional() }).optional(),
});
const filesSchema = z.object({
  files: z.array(fileSchema).default([]),
  nextPageToken: token.optional(),
  incompleteSearch: z.boolean().optional(),
});
const drivesSchema = z.object({
  drives: z.array(z.object({ id: identifier, name: z.string() })).default([]),
  nextPageToken: token.optional(),
});
const failureSchema = z.object({
  error: z.object({ errors: z.array(z.object({ reason: z.string() })).optional() }),
});

export function myDriveSpace(connectionId: string): Space {
  return driveSpace(connectionId, myDriveId, { messageKey: 'myDrive' }, 'root');
}

export function googleDriveAdapterFactory(request: typeof fetch = fetch): AdapterFactory {
  return {
    provider: 'google-drive',
    async create(connection, { credentials }, context) {
      if (!connection.credentialRef) throw new StorageError('AuthRequired');
      const authorization = await credentials.resolve(connection.credentialRef, context);
      if (!matchesGoogleDriveAuthorization(authorization, connection)) {
        throw new StorageError('AuthRequired');
      }
      return new GoogleDriveAdapter(authorization, request);
    },
  };
}

class GoogleDriveAdapter implements StorageAdapter {
  readonly connectionId: string;

  constructor(
    private readonly authorization: GoogleDriveAuthorization,
    private readonly request: typeof fetch,
  ) {
    this.connectionId = authorization.connectionId;
  }

  async listSpaces(context: OperationContext): Promise<Space[]> {
    const spaces = [myDriveSpace(this.connectionId)];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        fields: 'nextPageToken,drives(id,name)',
        pageSize: '100',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this.requestJson('drives', params, drivesSchema, context);
      for (const { id, name } of page.drives) {
        spaces.push(driveSpace(this.connectionId, sharedPrefix + id, name, id));
      }
      pageToken = page.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) throw new StorageError('OutcomeUnknown');
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return spaces;
  }

  async capabilities() {
    return { ...listSupported, rename: { support: 'supported' } } as const;
  }

  async stat(ref: EntryRef, context: OperationContext): Promise<Entry> {
    const id = parse(identifier, ref.locator);
    const driveId = this.sharedDriveId(ref.spaceId);
    const params = new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' });
    const file = await this.requestJson('files/' + id, params, fileSchema, context);
    if (file.trashed || (file.driveId !== driveId && file.id !== driveId)) {
      throw new StorageError('NotFound');
    }
    return fileEntry(ref, file);
  }

  async list(
    parent: EntryRef,
    { pageSize = 100, cursor }: ListRequest,
    context: OperationContext,
  ): Promise<EntryPage> {
    const id = parse(identifier, parent.locator);
    const driveId = this.sharedDriveId(parent.spaceId);
    if (!cursor && (await this.stat(parent, context)).kind !== 'directory') {
      throw new StorageError('InvalidArgument');
    }
    const params = new URLSearchParams({
      q: `'${id}' in parents and trashed = false`,
      fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
      orderBy: 'name_natural',
      pageSize: String(Math.min(1000, pageSize)),
      spaces: 'drive',
      corpora: driveId ? 'drive' : 'user',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: String(Boolean(driveId)),
    });
    if (driveId) params.set('driveId', driveId);
    if (cursor) params.set('pageToken', cursor);
    const page = await this.requestJson('files', params, filesSchema, context);
    if (page.incompleteSearch) throw new StorageError('OutcomeUnknown');
    const entries = page.files.map((file) => fileEntry({ ...parent, locator: file.id }, file));
    return page.nextPageToken ? { entries, nextCursor: page.nextPageToken } : { entries };
  }

  async rename(ref: EntryRef, name: string, context: OperationContext): Promise<Entry> {
    const id = parse(identifier, ref.locator);
    const driveId = this.sharedDriveId(ref.spaceId);
    if (id === 'root' || id === driveId) throw new StorageError('InvalidArgument');
    const entry = await this.stat(ref, context);
    if (entry.capabilities.rename?.support === 'unsupported')
      throw new StorageError('PermissionDenied');
    if (entry.name === name) return entry;
    const params = new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' });
    const file = await this.requestJson('files/' + id, params, fileSchema, context, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    if (file.id !== id || file.trashed || file.driveId !== driveId)
      throw new StorageError('OutcomeUnknown');
    return fileEntry(ref, file);
  }

  async dispose() {}

  private sharedDriveId(spaceId: string): string | undefined {
    if (spaceId === myDriveId) return undefined;
    if (!spaceId.startsWith(sharedPrefix)) throw new StorageError('InvalidArgument');
    return parse(identifier, spaceId.slice(sharedPrefix.length));
  }

  private async requestJson<T>(
    path: string,
    params: URLSearchParams,
    schema: z.ZodType<T>,
    context: OperationContext,
    update: Pick<RequestInit, 'method' | 'body'> = {},
  ): Promise<T> {
    throwIfAborted(context.signal);
    const accessToken = await this.authorization.getAccessToken(context);
    const timeout = AbortSignal.timeout(20_000);
    const signal = context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
    let response: Response;
    try {
      response = await this.request(
        `https://www.googleapis.com/drive/v3/${path}?${params.toString()}`,
        {
          ...update,
          headers: {
            Authorization: 'Bearer ' + accessToken,
            ...(update.body ? { 'Content-Type': 'application/json' } : {}),
          },
          redirect: 'error',
          signal,
        },
      );
    } catch (error) {
      throwIfAborted(context.signal);
      throw new StorageError('NetworkError', { cause: error });
    }
    const payload: unknown = await response.json().catch(() => undefined);
    throwIfAborted(context.signal);
    if (timeout.aborted) throw new StorageError('NetworkError');
    if (!response.ok) throw driveFailure(response.status, payload);
    return parse(schema, payload, 'OutcomeUnknown');
  }
}

function driveSpace(connectionId: string, id: string, name: Space['name'], locator: string): Space {
  return { id, connectionId, name, root: { connectionId, spaceId: id, locator } };
}

function fileEntry(ref: EntryRef, file: z.infer<typeof fileSchema>): Entry {
  let kind: Entry['kind'] = 'file';
  if (file.mimeType === 'application/vnd.google-apps.folder') kind = 'directory';
  else if (file.mimeType === 'application/vnd.google-apps.shortcut') kind = 'link';
  const size = Number(file.size);
  return {
    ref,
    name: file.name,
    kind,
    mediaType: file.mimeType,
    modifiedAt: file.modifiedTime,
    size: Number.isSafeInteger(size) ? size : undefined,
    capabilities: {
      ...(kind === 'directory' ? listSupported : {}),
      rename: {
        support:
          file.capabilities?.canRename === undefined
            ? 'unknown'
            : file.capabilities.canRename
              ? 'supported'
              : 'unsupported',
      },
    },
  };
}

function driveFailure(status: number, payload: unknown): StorageError {
  if (status === 401) return new StorageError('AuthRequired');
  if (status === 404) return new StorageError('NotFound');
  const failure = failureSchema.safeParse(payload);
  const limited = failure.data?.error.errors?.some(({ reason }) =>
    /ratelimit|quota|dailylimit/i.test(reason),
  );
  if (status === 429 || limited) return new StorageError('RateLimited');
  if (status === 403) return new StorageError('PermissionDenied');
  if (status === 400) return new StorageError('InvalidArgument');
  return new StorageError(status >= 500 ? 'NetworkError' : 'OutcomeUnknown');
}
