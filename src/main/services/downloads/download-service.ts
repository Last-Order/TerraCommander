import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  DownloadProgress,
  DownloadRequest,
  DownloadRunResult,
  DownloadExecution,
  DownloadWork,
  DownloadBatchRequest,
  PreparedDownloadBatch,
  DownloadWorkRef,
} from './download-types';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import { checkDownloadTarget } from './download-output';
import { downloadDirectory, DownloadError, validateDownloadName } from './download-paths';
import { type DownloadTransfer, type DownloadSource } from './download-transfer';
import { DownloadPlan } from './download-plan';
import { downloadTargetInfo } from './download-directories';
import { allocateDownloadNames, downloadPathKey, downloadPathsOverlap } from './download-names';
import type { EntryRef } from '@shared/storage';

interface DownloadRecord {
  owner: number;
  path: string;
  transfer: DownloadTransfer;
  sourceKey: string;
  planId: string;
  itemId: number;
}

interface DownloadPlanRecord {
  owner: number;
  keys: string[];
  plan: DownloadPlan;
  reserved: boolean;
  sources: Set<string>;
  standalone: boolean;
}

/** Owns local reservations and transfer lifetimes; scheduling remains in the session queue. */
export class DownloadService {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly targets = new Set<string>();
  private readonly plans = new Map<string, DownloadPlanRecord>();
  private readonly preparations = new Set<
    Promise<DownloadWork | DownloadExecution | PreparedDownloadBatch>
  >();
  private readonly filePreparations = new Map<string, Promise<DownloadExecution>>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly lifetime = new AbortController();

  constructor(private readonly source: DownloadSource) {}

  prepare(owner: number, request: DownloadRequest): Promise<DownloadWork> {
    const pending = this.prepareTarget(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  private async prepareTarget(owner: number, request: DownloadRequest): Promise<DownloadWork> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    const directory = await downloadDirectory(request.directory);
    const entry = await this.source.stat(request.ref, { signal: this.lifetime.signal });
    if (entry.kind !== 'file' || entry.capabilities.read?.support === 'unsupported')
      throw new StorageError('Unsupported');
    if (entry.name !== request.expectedName) throw new StorageError('PreconditionFailed');
    validateDownloadName(entry.name);
    const path = join(directory, entry.name);
    const key = downloadPathKey(path);
    this.assertAvailable([key]);
    await checkDownloadTarget(path, request.replace);
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');
    this.assertAvailable([key]);
    const id = randomUUID();
    this.targets.add(key);
    this.plans.set(id, {
      owner,
      keys: [key],
      reserved: true,
      sources: new Set([this.sourceKey(entry.ref)]),
      standalone: true,
      plan: new DownloadPlan(
        this.source,
        directory,
        [{ entry: structuredClone(entry), name: entry.name, replace: request.replace }],
        true,
        () => {},
      ),
    });
    return { ref: { planId: id, itemId: 0 }, path };
  }

  prepareBatch(owner: number, request: DownloadBatchRequest): Promise<PreparedDownloadBatch> {
    const pending = this.prepareBatchTargets(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  private async prepareBatchTargets(
    owner: number,
    request: DownloadBatchRequest,
  ): Promise<PreparedDownloadBatch> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    const directory = await downloadDirectory(request.directory);
    if (!request.entries.length) throw new StorageError('InvalidArgument');
    const seen = new Set<string>();
    const entries = [];
    for (const selected of request.entries) {
      const { connectionId, spaceId, locator } = selected.ref;
      const key = JSON.stringify([connectionId, spaceId, locator]);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = await this.source.stat(selected.ref, { signal: this.lifetime.signal });
      if (entry.name !== selected.expectedName) throw new StorageError('PreconditionFailed');
      if (
        (entry.kind !== 'file' && entry.kind !== 'directory') ||
        (entry.kind === 'file' && entry.capabilities.read?.support === 'unsupported') ||
        (entry.kind === 'directory' &&
          (!this.source.list || entry.capabilities.list?.support === 'unsupported'))
      )
        throw new StorageError('Unsupported');
      validateDownloadName(entry.name);
      entries.push(entry);
    }
    const names = allocateDownloadNames(entries);
    const roots = [];
    const conflicts: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const name = names[index]!;
      validateDownloadName(name);
      const existing = await downloadTargetInfo(join(directory, name));
      if (existing) conflicts.push(name);
      roots.push({ entry: structuredClone(entry), name, replace: existing !== undefined });
    }
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');
    const keys = names.map((name) => downloadPathKey(join(directory, name)));
    this.assertAvailable(keys);
    for (const key of keys) this.targets.add(key);
    const id = randomUUID();
    const sources = new Set<string>();
    this.plans.set(id, {
      owner,
      keys,
      sources,
      standalone: false,
      reserved: true,
      plan: new DownloadPlan(this.source, directory, roots, conflicts.length === 0, (entry) =>
        sources.add(this.sourceKey(entry.ref)),
      ),
    });
    return { id, path: directory, conflicts, items: this.plans.get(id)!.plan.roots };
  }

  confirmBatch(owner: number, id: string): void {
    this.ownedPlan(owner, id).plan.confirm();
  }

  private reservePlan(record: DownloadPlanRecord): void {
    if (record.reserved) return;
    this.assertAvailable(record.keys);
    record.plan.reopen();
    for (const key of record.keys) this.targets.add(key);
    record.reserved = true;
  }

  discoverBatchDirectory(owner: number, id: string, itemId: number, offset: number) {
    const record = this.ownedPlan(owner, id);
    this.reservePlan(record);
    return record.plan.directoryPage(itemId, offset);
  }

  async resolveWork(owner: number, ref: DownloadWorkRef): Promise<DownloadExecution> {
    this.ownedPlan(owner, ref.planId);
    const key = `${ref.planId}:${ref.itemId}`;
    if (this.filePreparations.has(key)) throw new DownloadError('DownloadTargetBusy');
    const pending = this.prepareExecution(owner, ref.planId, ref.itemId);
    this.preparations.add(pending);
    this.filePreparations.set(key, pending);
    try {
      return await pending;
    } finally {
      this.preparations.delete(pending);
      this.filePreparations.delete(key);
      this.finishStandalone(ref.planId);
    }
  }

  async cancelWork(owner: number, ref: DownloadWorkRef): Promise<void> {
    await this.cancelBatchItem(owner, ref.planId, ref.itemId);
    const pending = this.filePreparations.get(`${ref.planId}:${ref.itemId}`);
    if (pending) await Promise.allSettled([pending]);
    this.finishStandalone(ref.planId);
  }

  async releaseWork(owner: number, ref: DownloadWorkRef): Promise<void> {
    const record = this.plans.get(ref.planId);
    if (record?.owner === owner && record.standalone) await this.releaseBatch(owner, ref.planId);
  }

  private async prepareExecution(
    owner: number,
    batchId: string,
    itemId: number,
  ): Promise<DownloadExecution> {
    const record = this.ownedPlan(owner, batchId);
    this.reservePlan(record);
    if (
      [...this.records.values()].some((item) => item.planId === batchId && item.itemId === itemId)
    )
      throw new DownloadError('DownloadTargetBusy');
    const prepared = await record.plan.prepareFile(itemId);
    throwIfAborted(this.lifetime.signal);
    if (this.plans.get(batchId) !== record) throw new StorageError('Cancelled');
    const id = randomUUID();
    this.records.set(id, {
      owner,
      path: prepared.path,
      sourceKey: this.sourceKey(prepared.entry.ref),
      transfer: prepared.transfer,
      planId: batchId,
      itemId,
    });
    return { id, path: prepared.path };
  }

  async cancelBatchItem(owner: number, batchId: string, itemId: number): Promise<void> {
    const record = this.ownedPlan(owner, batchId);
    record.plan.cancelItem(itemId);
    await Promise.all(
      [...this.records]
        .filter(([, item]) => item.planId === batchId && item.itemId === itemId)
        .map(([id]) => this.cancel(owner, id)),
    );
  }

  finishBatch(owner: number, id: string): void {
    const record = this.ownedPlan(owner, id);
    if ([...this.records.values()].some((item) => item.planId === id))
      throw new DownloadError('DownloadTargetBusy');
    record.plan.finish();
    this.releasePlanTargets(record);
  }

  async releaseBatch(owner: number, id: string): Promise<void> {
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) return;
    this.plans.delete(id);
    try {
      await Promise.all(
        [...this.records]
          .filter(([, item]) => item.planId === id)
          .map(([fileId]) => this.cancel(owner, fileId)),
      );
      await record.plan.release();
    } finally {
      this.releasePlanTargets(record);
    }
  }

  run(
    owner: number,
    id: string,
    onProgress: (progress: DownloadProgress) => void,
    attempt: string = randomUUID(),
  ): Promise<DownloadRunResult> {
    throwIfAborted(this.lifetime.signal);
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
    for (const [id, record] of this.plans) {
      if (record.owner === owner) void this.releaseBatch(owner, id).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const records = [...this.records];
    await Promise.allSettled([
      ...records.map(([id, record]) => this.cancel(record.owner, id)),
      ...[...this.plans].map(([id, record]) => this.releaseBatch(record.owner, id)),
      ...this.preparations,
    ]);
    this.records.clear();
    this.targets.clear();
    this.plans.clear();
  }

  private finishStandalone(id: string): void {
    const record = this.plans.get(id);
    if (record?.standalone && ![...this.records.values()].some((item) => item.planId === id)) {
      record.plan.finish();
      this.releasePlanTargets(record);
    }
  }

  private assertAvailable(keys: readonly string[]): void {
    if (keys.some((key) => [...this.targets].some((target) => downloadPathsOverlap(key, target))))
      throw new DownloadError('DownloadTargetBusy');
  }

  assertSourceAvailable(ref: EntryRef): void {
    const key = this.sourceKey(ref);
    if (
      [...this.records.values()].some((record) => record.sourceKey === key) ||
      [...this.plans.values()].some((record) => record.reserved && record.sources.has(key))
    )
      throw new DownloadError('DownloadTargetBusy');
  }

  private sourceKey({ connectionId, spaceId, locator }: EntryRef): string {
    return JSON.stringify([connectionId, spaceId, locator]);
  }

  private ownedPlan(owner: number, id: string): DownloadPlanRecord {
    throwIfAborted(this.lifetime.signal);
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) throw new StorageError('InvalidArgument');
    return record;
  }

  private releasePlanTargets(record: DownloadPlanRecord): void {
    if (!record.reserved) return;
    for (const key of record.keys) this.targets.delete(key);
    record.reserved = false;
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
    this.finishStandalone(record.planId);
  }
}
