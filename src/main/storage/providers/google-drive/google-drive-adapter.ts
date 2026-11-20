import { z } from 'zod';
import type {
  Capabilities,
  CapabilityScope,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
  Space,
  SourceDescriptor,
  WriteTarget,
} from '@shared/storage';
import { matchesGoogleDriveAuthorization, type GoogleDriveAuthorization } from './authorization';
import type { ByteSource, OperationContext } from '@main/storage/core/contracts';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import { parse } from '@main/storage/core/validation';
import type { AdapterFactory, StorageAdapter } from '@main/storage/ports/adapter';
import type { StorageLogger } from '@main/storage/ports/services';
import { logGoogleDriveFailure } from './google-drive-diagnostics';
import { driveFailure } from './google-drive-errors';
import { readGoogleDriveContent } from './google-drive-read';
import { createGoogleDriveWriteSession } from './google-drive-write';

const myDriveId = 'my-drive';
const sharedPrefix = 'shared:';
const supported = { support: 'supported' } as const;
const unsupported = { support: 'unsupported' } as const;
const unknown = { support: 'unknown' } as const;
const driveBaseCapabilities: Capabilities = {
  list: supported,
  read: supported,
  rangeRead: supported,
  rename: supported,
  remove: supported,
  write: unknown,
  createDirectory: unknown,
  copyWithin: unsupported,
  moveWithin: unsupported,
  conditionalRead: unsupported,
  conditionalWrite: unsupported,
  resumeWrite: unsupported,
};
const identifier = z.string().regex(/^[A-Za-z0-9_-]+$/);
const generatedIdsSchema = z.object({ ids: z.tuple([identifier]) });
const token = z.string().min(1);
const fileFields =
  'id,name,mimeType,driveId,trashed,size,modifiedTime,sha256Checksum,md5Checksum,capabilities(canRename,canTrash,canDownload,canAddChildren)';
const fileSchema = z.object({
  id: identifier,
  name: z.string(),
  mimeType: token,
  driveId: identifier.optional(),
  trashed: z.boolean().optional(),
  parents: z.array(identifier).optional(),
  size: z.string().regex(/^\d+$/).optional(),
  modifiedTime: z.iso.datetime({ offset: true }).optional(),
  sha256Checksum: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .optional(),
  md5Checksum: z
    .string()
    .regex(/^[a-fA-F0-9]{32}$/)
    .optional(),
  capabilities: z
    .object({
      canRename: z.boolean().optional(),
      canTrash: z.boolean().optional(),
      canDownload: z.boolean().optional(),
      canAddChildren: z.boolean().optional(),
    })
    .optional(),
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

export function myDriveSpace(connectionId: string): Space {
  return driveSpace(connectionId, myDriveId, { messageKey: 'myDrive' }, 'root');
}

export function googleDriveAdapterFactory(request: typeof fetch = fetch): AdapterFactory {
  return {
    provider: 'google-drive',
    async create(connection, { credentials, logger }, context) {
      if (!connection.credentialRef) throw new StorageError('AuthRequired');
      const authorization = await credentials.resolve(connection.credentialRef, context);
      if (!matchesGoogleDriveAuthorization(authorization, connection)) {
        throw new StorageError('AuthRequired');
      }
      return new GoogleDriveAdapter(authorization, request, logger);
    },
  };
}

class GoogleDriveAdapter implements StorageAdapter {
  readonly connectionId: string;

  constructor(
    private readonly authorization: GoogleDriveAuthorization,
    private readonly request: typeof fetch,
    private readonly logger: StorageLogger,
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

  async capabilities(scope: CapabilityScope, ctx: OperationContext): Promise<Capabilities> {
    throwIfAborted(ctx.signal);
    if (scope.kind === 'space') {
      this.sharedDriveId(scope.spaceId);
      return { ...driveBaseCapabilities };
    }
    if (scope.kind === 'entry') {
      return (await this.stat(scope.ref, ctx)).capabilities;
    }
    return { ...driveBaseCapabilities };
  }

  async stat(ref: EntryRef, context: OperationContext): Promise<Entry> {
    const file = await this.getFile(ref, context);
    const isRoot = ref.locator === 'root' || ref.locator === this.sharedDriveId(ref.spaceId);
    return fileEntry(ref, file, isRoot);
  }

  private async getFile(ref: EntryRef, context: OperationContext, fields = fileFields) {
    const id = parse(identifier, ref.locator);
    const driveId = this.sharedDriveId(ref.spaceId);
    const params = new URLSearchParams({ fields, supportsAllDrives: 'true' });
    const file = await this.requestJson('files/' + id, params, fileSchema, context);
    if (file.trashed || (file.driveId !== driveId && file.id !== driveId)) {
      throw new StorageError('NotFound');
    }
    return file;
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
    const entries = page.files.map((file) =>
      fileEntry({ ...parent, locator: file.id }, file, false),
    );
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
    return fileEntry(ref, file, false);
  }

  async read(ref: EntryRef, options: ReadOptions, context: OperationContext) {
    if (options.expectedRevision !== undefined) throw new StorageError('Unsupported');
    const entry = await this.stat(ref, context);
    if (entry.kind !== 'file' || entry.mediaType?.startsWith('application/vnd.google-apps.'))
      throw new StorageError('Unsupported');
    if (entry.capabilities.read?.support === 'unsupported')
      throw new StorageError('PermissionDenied');
    return readGoogleDriveContent(
      ref.locator,
      this.authorization,
      this.request,
      context,
      options.range,
      this.logger,
    );
  }

  async write(target: WriteTarget, source: ByteSource, context: OperationContext): Promise<Entry> {
    if (source.kind !== 'reopenable') throw new StorageError('Unsupported');
    const session = await this.prepareWrite(target, source.descriptor, context);
    return session.run(source, context);
  }

  async prepareWrite(target: WriteTarget, source: SourceDescriptor, context: OperationContext) {
    if (target.kind !== 'create') throw new StorageError('Unsupported');
    const { parent, name } = target;
    const folder = await this.getFile(parent, context);
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new StorageError('InvalidArgument');
    }
    if (folder.capabilities?.canAddChildren === false) throw new StorageError('PermissionDenied');

    const {
      ids: [id],
    } = await this.requestJson(
      'files/generateIds',
      new URLSearchParams({ count: '1', space: 'drive' }),
      generatedIdsSchema,
      context,
    );
    const ref = { ...parent, locator: id };
    const fields = `${fileFields},parents`;
    const complete = (payload: unknown): Entry => {
      const uploaded = parse(fileSchema, payload, 'OutcomeUnknown');
      if (
        uploaded.id !== id ||
        uploaded.trashed ||
        uploaded.name !== name ||
        uploaded.driveId !== this.sharedDriveId(parent.spaceId) ||
        !uploaded.parents?.includes(folder.id) ||
        uploaded.size === undefined ||
        Number(uploaded.size) !== source.size ||
        uploaded.mimeType.startsWith('application/vnd.google-apps.')
      ) {
        throw new StorageError('OutcomeUnknown');
      }
      return fileEntry(ref, uploaded, false);
    };
    return createGoogleDriveWriteSession(
      {
        id,
        name,
        parentId: folder.id,
        fields,
        size: source.size,
        complete,
        reconcile: async (operation) => complete(await this.getFile(ref, operation, fields)),
      },
      this.authorization,
      this.request,
    );
  }

  async createDirectory(target: CreateTarget, context: OperationContext): Promise<Entry> {
    const { parent, name } = target;
    const folder = await this.getFile(parent, context);
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new StorageError('InvalidArgument');
    }
    if (folder.capabilities?.canAddChildren === false) throw new StorageError('PermissionDenied');
    const params = new URLSearchParams({
      fields: `${fileFields},parents`,
      supportsAllDrives: 'true',
    });
    const created = await this.requestJson('files', params, fileSchema, context, {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [folder.id],
      }),
    });
    if (
      created.trashed ||
      created.name !== name ||
      created.mimeType !== 'application/vnd.google-apps.folder' ||
      created.driveId !== this.sharedDriveId(parent.spaceId) ||
      !created.parents?.includes(folder.id)
    ) {
      throw new StorageError('OutcomeUnknown');
    }
    return fileEntry({ ...parent, locator: created.id }, created, false);
  }

  async remove(ref: EntryRef, context: OperationContext): Promise<void> {
    const id = parse(identifier, ref.locator);
    const driveId = this.sharedDriveId(ref.spaceId);
    if (id === 'root' || id === driveId) throw new StorageError('InvalidArgument');
    const entry = await this.stat(ref, context);
    if (entry.kind !== 'file' && entry.kind !== 'link') throw new StorageError('Unsupported');
    if (entry.capabilities.remove?.support === 'unsupported')
      throw new StorageError('PermissionDenied');
    const file = await this.requestJson(
      'files/' + id,
      new URLSearchParams({ fields: fileFields, supportsAllDrives: 'true' }),
      fileSchema,
      context,
      { method: 'PATCH', body: JSON.stringify({ trashed: true }) },
    );
    if (file.id !== id || file.driveId !== driveId || file.trashed !== true)
      throw new StorageError('OutcomeUnknown');
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
    let response: Response | undefined;
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
      const payload: unknown = await response.json().catch(() => undefined);
      throwIfAborted(context.signal);
      if (timeout.aborted) throw new StorageError('NetworkError');
      if (!response.ok) throw driveFailure(response.status, payload);
      return parse(schema, payload, 'OutcomeUnknown');
    } catch (error) {
      throwIfAborted(context.signal);
      const failure =
        error instanceof StorageError ? error : new StorageError('NetworkError', { cause: error });
      logGoogleDriveFailure(this.logger, failure, {
        stage: 'metadata',
        timedOut: timeout.aborted,
        ...(response ? { status: response.status } : {}),
      });
      throw failure;
    }
  }
}

function driveSpace(connectionId: string, id: string, name: Space['name'], locator: string): Space {
  return { id, connectionId, name, root: { connectionId, spaceId: id, locator } };
}

function fileEntry(ref: EntryRef, file: z.infer<typeof fileSchema>, isRoot: boolean): Entry {
  let kind: Entry['kind'] = 'file';
  if (file.mimeType === 'application/vnd.google-apps.folder') kind = 'directory';
  else if (file.mimeType === 'application/vnd.google-apps.shortcut') kind = 'link';
  const size = kind === 'file' && file.size !== undefined ? Number(file.size) : undefined;
  const checksums = [
    ...(file.sha256Checksum
      ? [{ algorithm: 'sha256', value: file.sha256Checksum.toLowerCase() }]
      : []),
    ...(file.md5Checksum ? [{ algorithm: 'md5', value: file.md5Checksum.toLowerCase() }] : []),
  ];
  return {
    ref,
    name: file.name,
    kind,
    mediaType: file.mimeType,
    ...(file.modifiedTime !== undefined ? { modifiedAt: file.modifiedTime } : {}),
    ...(size !== undefined && Number.isSafeInteger(size) ? { size } : {}),
    ...(checksums.length > 0 ? { checksums } : {}),
    capabilities: {
      ...driveBaseCapabilities,
      list: kind === 'directory' ? supported : unsupported,
      rangeRead:
        kind === 'file' && !file.mimeType.startsWith('application/vnd.google-apps.')
          ? supported
          : unsupported,
      read: grantedCapability(
        kind !== 'file' || file.mimeType.startsWith('application/vnd.google-apps.'),
        file.capabilities?.canDownload,
      ),
      write: grantedCapability(kind !== 'directory', file.capabilities?.canAddChildren),
      createDirectory: grantedCapability(kind !== 'directory', file.capabilities?.canAddChildren),
      rename: grantedCapability(isRoot, file.capabilities?.canRename),
      remove: grantedCapability(isRoot || kind === 'directory', file.capabilities?.canTrash),
    },
  };
}

function grantedCapability(excluded: boolean, granted: boolean | undefined) {
  if (excluded || granted === false) return unsupported;
  return granted ? supported : unknown;
}
