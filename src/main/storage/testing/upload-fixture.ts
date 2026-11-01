import type { Entry, SourceDescriptor, WriteTarget } from '../../../shared/storage/models';
import { targetRef } from '../core/adapter-operations';
import type {
  DriverCheckpoint,
  OperationContext,
  ReopenableByteSource,
  UploadDriver,
  UploadHooks,
  UploadObservation,
} from '../core/contracts';
import { StorageError, throwIfAborted } from '../core/errors';
import { fixtureEntry, FixtureAdapter } from './fixtures';

interface RemoteSession {
  source: SourceDescriptor;
  target: WriteTarget;
  chunks: Map<number, Uint8Array>;
  entry?: Entry;
  expired?: boolean;
  unknown?: boolean;
}

export class UploadFixtureBackend {
  readonly sessions = new Map<string, RemoteSession>();
  sequence = 0;
}

export class FixtureUploadDriver implements UploadDriver {
  calls: string[] = [];
  failAfterCheckpoint = false;
  failBeforeCheckpoint = false;
  loseCompletionResponse = false;
  cleanup: 'complete' | 'pending' | 'unsupported' = 'complete';

  constructor(
    readonly backend: UploadFixtureBackend,
    private readonly mode: 'sequential' | 'parts' = 'sequential',
  ) {}

  validate(value: DriverCheckpoint): boolean {
    return (
      value.version === 1 &&
      value.payload !== null &&
      !Array.isArray(value.payload) &&
      typeof value.payload === 'object' &&
      typeof value.payload.session === 'string'
    );
  }

  async create(
    target: WriteTarget,
    source: SourceDescriptor,
    ctx: OperationContext,
  ): Promise<DriverCheckpoint> {
    throwIfAborted(ctx.signal);
    this.calls.push('create');
    const session = String(++this.backend.sequence);
    this.backend.sessions.set(session, {
      source: structuredClone(source),
      target: structuredClone(target),
      chunks: new Map(),
    });
    return {
      version: 1,
      payload: { session, privateSessionUrl: 'https://private.invalid/secret-session' },
    };
  }

  async reconcile(checkpoint: DriverCheckpoint, ctx: OperationContext): Promise<UploadObservation> {
    throwIfAborted(ctx.signal);
    this.calls.push('reconcile');
    const session = this.session(checkpoint);
    const confirmedBytes = [...session.chunks.values()].reduce(
      (sum, value) => sum + value.length,
      0,
    );
    const progress = { processedBytes: confirmedBytes, confirmedBytes };
    if (session.expired) return { checkpoint, progress, state: 'expired' };
    if (session.unknown) return { checkpoint, progress, state: 'unknown' };
    if (session.entry) return { checkpoint, progress, state: 'completed', entry: session.entry };
    return { checkpoint, progress, state: 'suspended' };
  }

  async run(
    checkpoint: DriverCheckpoint,
    source: ReopenableByteSource,
    hooks: UploadHooks,
    ctx: OperationContext,
  ): Promise<Entry> {
    this.calls.push('run');
    const session = this.session(checkpoint);
    const offsets = Array.from(
      { length: Math.ceil(session.source.size / 2) },
      (_, index) => index * 2,
    );
    if (this.mode === 'parts' && offsets.length > 1)
      [offsets[0], offsets[1]] = [offsets[1]!, offsets[0]!];
    for (const offset of offsets) {
      throwIfAborted(ctx.signal);
      if (session.chunks.has(offset)) continue;
      const length = Math.min(2, session.source.size - offset);
      const handle = await source.open({ offset, length }, ctx);
      const chunks: Uint8Array[] = [];
      try {
        for await (const chunk of handle.stream) chunks.push(chunk as Uint8Array);
      } finally {
        await handle.dispose();
      }
      session.chunks.set(offset, Buffer.concat(chunks));
      if (this.failBeforeCheckpoint) {
        this.failBeforeCheckpoint = false;
        throw new StorageError('NetworkError');
      }
      const confirmedBytes = [...session.chunks.values()].reduce(
        (sum, value) => sum + value.length,
        0,
      );
      await hooks.checkpoint(checkpoint, { processedBytes: confirmedBytes, confirmedBytes });
      if (this.failAfterCheckpoint) {
        this.failAfterCheckpoint = false;
        throw new StorageError('NetworkError', { retryHint: 'safe' });
      }
    }
    throwIfAborted(ctx.signal);
    const ref = targetRef(session.target);
    session.entry = {
      ...fixtureEntry({ ...ref, locator: `uploaded-${this.backend.sequence}` }),
      size: session.source.size,
    };
    if (this.loseCompletionResponse) {
      this.loseCompletionResponse = false;
      throw new StorageError('OutcomeUnknown');
    }
    return session.entry;
  }

  async discard(checkpoint: DriverCheckpoint, _ctx: OperationContext) {
    this.calls.push('discard');
    const session = this.session(checkpoint);
    if (session.entry) throw new StorageError('PreconditionFailed');
    return { cleanup: this.cleanup };
  }

  private session(checkpoint: DriverCheckpoint): RemoteSession {
    const payload = checkpoint.payload;
    if (
      !this.validate(checkpoint) ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    )
      throw new StorageError('ResumeInvalid');
    const sessionId = payload.session;
    if (typeof sessionId !== 'string') throw new StorageError('ResumeInvalid');
    const session = this.backend.sessions.get(sessionId);
    if (!session) throw new StorageError('ResumeExpired');
    return session;
  }
}

export class UploadFixtureAdapter extends FixtureAdapter {
  readonly uploads: FixtureUploadDriver;
  constructor(
    connectionId: string,
    backend: UploadFixtureBackend,
    mode: 'sequential' | 'parts' = 'sequential',
  ) {
    super(connectionId);
    this.uploads = new FixtureUploadDriver(backend, mode);
  }
}
