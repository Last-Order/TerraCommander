import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';
import type {
  DownloadProgress,
  DownloadRequest,
  DownloadRunResult,
  PreparedDownload,
} from '../../shared/downloads';
import { StorageError, throwIfAborted } from '../storage/core/errors';
import { checkDownloadTarget } from './download-output';
import { downloadDirectory, DownloadError, validateDownloadName } from './download-paths';
import { DownloadTransfer, type DownloadSource } from './download-transfer';

interface DownloadRecord {
  owner: number;
  key: string;
  transfer: DownloadTransfer;
}

/** Owns local reservations and transfer lifetimes; scheduling remains in the session queue. */
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
    if (this.targets.has(key)) throw new DownloadError('DownloadTargetBusy');
    await checkDownloadTarget(path, request.replace);
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');
    if (this.targets.has(key)) throw new DownloadError('DownloadTargetBusy');
    const id = randomUUID();
    this.targets.add(key);
    this.records.set(id, {
      owner,
      key,
      transfer: new DownloadTransfer(
        this.source,
        structuredClone(request),
        directory,
        path,
        structuredClone(entry),
      ),
    });
    return { id, path };
  }

  run(
    owner: number,
    id: string,
    onProgress: (progress: DownloadProgress) => void,
    attempt: string = randomUUID(),
  ): Promise<DownloadRunResult> {
    const record = this.owned(owner, id);
    const running = record.transfer.run(id, attempt, onProgress);
    return running.then(
      (result) => {
        if (result.status !== 'paused') this.release(id, record);
        return result;
      },
      (error: unknown) => {
        this.release(id, record);
        throw error;
      },
    );
  }

  pause(owner: number, id: string): Promise<void> {
    return this.owned(owner, id).transfer.pause();
  }

  async cancel(owner: number, id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) return;
    try {
      await record.transfer.cancel();
    } finally {
      this.release(id, record);
    }
  }

  cancelOwner(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, record] of this.records) {
      if (record.owner === owner) void this.cancel(owner, id).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const records = [...this.records];
    await Promise.allSettled([
      ...records.map(([id, record]) => this.cancel(record.owner, id)),
      ...this.preparations,
    ]);
    this.records.clear();
    this.targets.clear();
  }

  private owned(owner: number, id: string): DownloadRecord {
    throwIfAborted(this.lifetime.signal);
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new StorageError('InvalidArgument');
    return record;
  }

  private release(id: string, record: DownloadRecord): void {
    if (this.records.get(id) !== record) return;
    this.records.delete(id);
    this.targets.delete(record.key);
  }
}
