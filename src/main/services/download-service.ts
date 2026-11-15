import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rename, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadProgress, DownloadRequest, PreparedDownload } from '../../shared/downloads';
import type { Entry, EntryRef } from '../../shared/storage';
import type { OperationContext, ReadHandle } from '../storage/core/contracts';
import { StorageError, throwIfAborted } from '../storage/core/errors';
import { DownloadProgressReporter } from './download-progress-reporter';
import {
  downloadDirectory,
  DownloadError,
  downloadFailure,
  validateDownloadName,
} from './download-paths';

interface DownloadRecord {
  owner: number;
  request: DownloadRequest;
  path: string;
  directory: string;
  key: string;
  controller: AbortController;
  stage: 'prepared' | 'downloading' | 'saving' | 'completed';
  running?: Promise<void>;
}

interface DownloadSource {
  stat(ref: EntryRef, context: OperationContext): Promise<Entry>;
  read(ref: EntryRef, context: OperationContext): Promise<ReadHandle>;
}

/** Owns local destinations and read lifetimes; scheduling remains in the session queue. */
export class DownloadService {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly targets = new Set<string>();
  private readonly preparations = new Set<Promise<PreparedDownload>>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly lifetime = new AbortController();

  constructor(private readonly source: DownloadSource) {}

  prepare(owner: number, request: DownloadRequest): Promise<PreparedDownload> {
    const pending = this.prepareTarget(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  private async prepareTarget(owner: number, request: DownloadRequest): Promise<PreparedDownload> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    const directory = await downloadDirectory(request.directory);
    const entry = await this.source.stat(request.ref, { signal: this.lifetime.signal });
    if (entry.kind !== 'file' || entry.capabilities.read?.support === 'unsupported')
      throw new StorageError('Unsupported');
    if (entry.name !== request.expectedName) throw new StorageError('PreconditionFailed');
    validateDownloadName(entry.name);
    const path = join(directory, entry.name);
    const key = sep === '\\' ? path.toLowerCase() : path;
    await this.checkTarget(path, request.replace);
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');
    if (this.targets.has(key)) throw new DownloadError('DownloadTargetBusy');
    const id = randomUUID();
    this.targets.add(key);
    this.records.set(id, {
      owner,
      request: structuredClone(request),
      path,
      directory,
      key,
      controller: new AbortController(),
      stage: 'prepared',
    });
    return { id, path };
  }

  run(owner: number, id: string, onProgress: (progress: DownloadProgress) => void): Promise<void> {
    const record = this.owned(owner, id);
    if (record.stage !== 'prepared') throw new StorageError('InvalidArgument');
    record.stage = 'downloading';
    record.running = Promise.resolve().then(async () => {
      try {
        await this.transfer(id, record, onProgress);
        record.stage = 'completed';
      } catch (error) {
        this.records.delete(id);
        if (error instanceof DownloadError) throw error;
        throwIfAborted(record.controller.signal);
        downloadFailure(error);
      } finally {
        this.targets.delete(record.key);
      }
    });
    return record.running;
  }

  async cancel(owner: number, id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) return;
    if (record.stage === 'completed' || record.stage === 'saving') return;
    record.controller.abort();
    if (record.running) await record.running.catch(() => {});
    else {
      this.records.delete(id);
      this.targets.delete(record.key);
    }
  }

  cancelOwner(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, record] of this.records) {
      if (record.owner !== owner) continue;
      if (record.stage === 'completed') this.records.delete(id);
      else void this.cancel(owner, id);
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const pending = [...this.records].map(([id, record]) => this.cancel(record.owner, id));
    await Promise.allSettled([
      ...pending,
      ...this.preparations,
      ...[...this.records.values()].map((record) => record.running),
    ]);
    this.records.clear();
  }

  private owned(owner: number, id: string): DownloadRecord {
    throwIfAborted(this.lifetime.signal);
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new StorageError('InvalidArgument');
    return record;
  }

  private async checkTarget(path: string, replace: boolean): Promise<void> {
    const existing = await lstat(path).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      downloadFailure(error);
    });
    if (existing && !existing.isFile()) throw new DownloadError('InvalidDownloadName');
    if (existing && !replace) throw new StorageError('AlreadyExists');
  }

  private async transfer(
    id: string,
    record: DownloadRecord,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const signal = record.controller.signal;
    let temporary: string | undefined;
    let handle: ReadHandle | undefined;
    let output: FileHandle | undefined;
    let identity: BigIntStats | undefined;
    let completed = false;
    let completedBytes = 0;
    let reporter: DownloadProgressReporter | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      throwIfAborted(signal);
      await downloadDirectory(record.directory);
      let outputPath = record.path;
      if (record.request.replace) {
        await this.checkTarget(record.path, true);
        temporary = await mkdtemp(join(record.directory, '.terra-download-'));
        outputPath = join(temporary, 'content');
      }
      output = await open(outputPath, 'wx', 0o600);
      if (!record.request.replace) identity = await output.stat({ bigint: true });
      throwIfAborted(signal);
      handle = await this.source.read(record.request.ref, { signal });
      reporter = new DownloadProgressReporter(id, handle.length, () => completedBytes, onProgress);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          completedBytes += chunk.byteLength;
          callback(null, chunk);
        },
      });
      await pipeline(handle.stream, counter, output.createWriteStream({ flush: true }), { signal });
      if (handle.length !== undefined && completedBytes !== handle.length)
        throw new StorageError('OutcomeUnknown');
      await handle.dispose();
      handle = undefined;
      await output.close();
      if (record.request.replace) await this.checkTarget(record.path, true);
      else if (!identity || !(await matchesCreatedFile(record.path, identity))) {
        throw new StorageError('PreconditionFailed');
      }
      throwIfAborted(signal);
      // Both policies finish through a cancellation boundary; replacement publishes here.
      record.stage = 'saving';
      reporter.saving();
      if (temporary) await rename(join(temporary, 'content'), record.path);
      completed = true;
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    reporter?.dispose();
    let cleanupFailed = false;
    try {
      await handle?.dispose();
    } catch {
      cleanupFailed = true;
    }
    try {
      await output?.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
      else if (!completed && output) {
        if (!identity) cleanupFailed = true;
        else if (await matchesCreatedFile(record.path, identity)) await unlink(record.path);
      }
    } catch {
      cleanupFailed = true;
    }
    // Cleanup failures must remain visible even when the operation was canceled or published.
    if (cleanupFailed) throw new DownloadError('DownloadCleanupFailed');
    if (operationFailed) throw operationError;
  }
}

async function matchesCreatedFile(path: string, expected: BigIntStats): Promise<boolean> {
  const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return undefined;
    throw error;
  });
  return (
    current !== undefined &&
    current.isFile() &&
    current.dev === expected.dev &&
    current.ino === expected.ino
  );
}
