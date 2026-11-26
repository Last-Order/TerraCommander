import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import type { EntryRef } from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import { allocateUploadNames, commonLocalParent, uploadPathKey } from './upload-names';
import { UploadPlan, type UploadPlanRoot } from './upload-plan';
import { UploadTransfer, type UploadRunOptions } from './upload-transfer';
import type {
  PreparedUploadBatch,
  ResolvedUploadWork,
  UploadBatchRequest,
  UploadOperations,
  UploadPlanPage,
  UploadRequest,
  UploadRunResult,
  UploadWork,
  UploadWorkRef,
} from './upload-types';

interface UploadPlanRecord {
  owner: number;
  plan: UploadPlan;
  standalone: boolean;
  validateOnResolve?: { directory: StorageDirectory; requireCreateDirectory: boolean } | undefined;
}

function localStatError(error: unknown): never {
  if (error instanceof StorageError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
    throw new StorageError('NotFound');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new StorageError('PermissionDenied');
  }
  throw new StorageError('OutcomeUnknown', { cause: error });
}

function rootIdentity(stat: BigIntStats, path: string): string {
  return stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : uploadPathKey(path);
}

function transferKey(ref: UploadWorkRef): string {
  return `${ref.planId}:${ref.itemId}`;
}

/** Owns local upload discovery plans and destination folder retention; scheduling remains in the session queue. */
export class UploadService {
  private readonly plans = new Map<string, UploadPlanRecord>();
  private readonly transfers = new Map<string, UploadTransfer>();
  private readonly preparations = new Set<
    Promise<
      | UploadWork
      | PreparedUploadBatch
      | { kind: 'single'; work: UploadWork }
      | { kind: 'batch'; prepared: PreparedUploadBatch }
    >
  >();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly lifetime = new AbortController();

  constructor(private readonly operations: UploadOperations) {}

  prepareSelection(
    owner: number,
    request: UploadBatchRequest,
  ): Promise<
    { kind: 'single'; work: UploadWork } | { kind: 'batch'; prepared: PreparedUploadBatch }
  > {
    const pending = this.prepareSelectionTarget(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  private async prepareSelectionTarget(
    owner: number,
    request: UploadBatchRequest,
  ): Promise<
    { kind: 'single'; work: UploadWork } | { kind: 'batch'; prepared: PreparedUploadBatch }
  > {
    if (request.paths.length === 1) {
      const localPath = resolve(request.paths[0]!);
      const stat = await lstat(localPath, { bigint: true }).catch((error: unknown) =>
        localStatError(error),
      );
      if (stat.isFile()) {
        return {
          kind: 'single',
          work: await this.prepareSingle(
            owner,
            { parent: request.parent, path: localPath },
            request.validated,
            request.deferValidation,
          ),
        };
      }
    }
    return { kind: 'batch', prepared: await this.prepareBatchTargets(owner, request) };
  }

  prepare(owner: number, request: UploadRequest): Promise<UploadWork> {
    const pending = this.prepareSingle(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  prepareBatch(owner: number, request: UploadBatchRequest): Promise<PreparedUploadBatch> {
    const pending = this.prepareBatchTargets(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  discoverBatchDirectory(
    owner: number,
    id: string,
    itemId: number,
    offset: number,
  ): Promise<UploadPlanPage> {
    return this.ownedPlan(owner, id).plan.directoryPage(itemId, offset);
  }

  async resolveWork(owner: number, ref: UploadWorkRef): Promise<ResolvedUploadWork> {
    const record = this.ownedPlan(owner, ref.planId);
    if (record.validateOnResolve) {
      await this.validateDirectory(
        record.validateOnResolve.directory,
        record.validateOnResolve.requireCreateDirectory,
      );
      record.validateOnResolve = undefined;
    }
    record.plan.reopen();
    return record.plan.prepareFile(ref.itemId);
  }

  async runWork(
    owner: number,
    ref: UploadWorkRef,
    options: UploadRunOptions,
  ): Promise<UploadRunResult> {
    const key = transferKey(ref);
    let keepTransfer = false;
    try {
      let transfer = this.transfers.get(key);
      if (!transfer) {
        const work = await this.resolveWork(owner, ref);
        if (options.signal.aborted) {
          await this.cancelWork(owner, ref);
          return { status: 'cancelled' };
        }
        transfer = new UploadTransfer(work.size, work.prepare);
        this.transfers.set(key, transfer);
      }
      const result = await transfer.run(options);
      if (result.status === 'paused') keepTransfer = true;
      return result;
    } catch (error) {
      keepTransfer = this.transfers.has(key);
      throw error;
    } finally {
      if (!keepTransfer) this.transfers.delete(key);
    }
  }

  pauseWork(owner: number, ref: UploadWorkRef): void {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return;
    this.transfers.get(transferKey(ref))?.pause();
  }

  canRetryWork(owner: number, ref: UploadWorkRef): boolean {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return false;
    return this.transfers.get(transferKey(ref))?.retryable ?? true;
  }

  async cancelWork(owner: number, ref: UploadWorkRef): Promise<void> {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return;
    const key = transferKey(ref);
    try {
      record.plan.cancelItem(ref.itemId);
      this.transfers.get(key)?.cancel();
    } finally {
      this.transfers.delete(key);
    }
  }

  async releaseWork(owner: number, ref: UploadWorkRef): Promise<void> {
    this.transfers.delete(transferKey(ref));
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner || !record.standalone) return;
    this.plans.delete(ref.planId);
    await record.plan.release();
  }

  async cancelBatchItem(owner: number, id: string, itemId: number): Promise<void> {
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) return;
    record.plan.cancelItem(itemId);
  }

  finishBatch(owner: number, id: string): void {
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) return;
    record.plan.finish();
  }

  async releaseBatch(owner: number, id: string): Promise<void> {
    this.deletePlanTransfers(id);
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) return;
    this.plans.delete(id);
    await record.plan.release();
  }

  cancelOwner(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [id, record] of this.plans) {
      if (record.owner !== owner) continue;
      this.deletePlanTransfers(id);
      this.plans.delete(id);
      void record.plan.release();
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const plans = [...this.plans.values()];
    this.plans.clear();
    this.transfers.clear();
    await Promise.allSettled([
      ...this.preparations,
      ...plans.map((record) => record.plan.release()),
    ]);
  }

  private deletePlanTransfers(planId: string): void {
    const prefix = `${planId}:`;
    for (const key of this.transfers.keys()) {
      if (key.startsWith(prefix)) this.transfers.delete(key);
    }
  }

  async validateDestination(
    parent: EntryRef,
    requireCreateDirectory = false,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.validateDirectory(this.operations.directory(parent), requireCreateDirectory, signal);
  }

  private async validateDirectory(
    directory: StorageDirectory,
    requireCreateDirectory = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const effectiveSignal = signal
      ? AbortSignal.any([this.lifetime.signal, signal])
      : this.lifetime.signal;
    const entry = await directory.stat({ signal: effectiveSignal });
    if (entry.kind !== 'directory') throw new StorageError('InvalidArgument');
    if (entry.capabilities.write?.support === 'unsupported') {
      throw new StorageError('PermissionDenied');
    }
    if (requireCreateDirectory && entry.capabilities.createDirectory?.support === 'unsupported') {
      throw new StorageError('PermissionDenied');
    }
  }

  private async prepareSingle(
    owner: number,
    request: UploadRequest,
    validated = false,
    deferValidation = false,
  ): Promise<UploadWork> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    const directory = this.operations.directory(request.parent);
    if (!validated && !deferValidation) await this.validateDirectory(directory, false);
    const localPath = resolve(request.path);
    const stat = await lstat(localPath, { bigint: true }).catch((error: unknown) =>
      localStatError(error),
    );
    if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new StorageError('Unsupported');
    }
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');
    const name = basename(localPath);
    const size = Number(stat.size);
    const id = randomUUID();
    const plan = new UploadPlan([{ kind: 'file', localPath, name, size, directory }]);
    this.plans.set(id, {
      owner,
      plan,
      standalone: true,
      ...(!validated && deferValidation
        ? { validateOnResolve: { directory, requireCreateDirectory: false } }
        : {}),
    });
    return { ref: { planId: id, itemId: 0 }, parent: directory.ref, name, size };
  }

  private async prepareBatchTargets(
    owner: number,
    request: UploadBatchRequest,
  ): Promise<PreparedUploadBatch> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    if (!request.paths.length) throw new StorageError('InvalidArgument');
    const seen = new Set<string>();
    const inspected: {
      kind: 'file' | 'directory';
      localPath: string;
      name: string;
      size: number;
      identity?: string;
    }[] = [];
    let hasDirectory = false;
    for (const rawPath of request.paths) {
      const localPath = resolve(rawPath);
      const key = uploadPathKey(localPath);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = await lstat(localPath, { bigint: true }).catch((error: unknown) =>
        localStatError(error),
      );
      if (stat.isDirectory()) {
        hasDirectory = true;
        inspected.push({
          kind: 'directory',
          localPath,
          name: basename(localPath),
          size: 0,
          identity: rootIdentity(stat, localPath),
        });
      } else if (stat.isFile() && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
        inspected.push({
          kind: 'file',
          localPath,
          name: basename(localPath),
          size: Number(stat.size),
        });
      } else {
        throw new StorageError('Unsupported');
      }
    }
    const directory = this.operations.directory(request.parent);
    const needsValidation = !request.validated || hasDirectory;
    if (needsValidation && !request.deferValidation) {
      await this.validateDirectory(directory, hasDirectory);
    }
    const semantics = await directory.semantics();
    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');

    const names = allocateUploadNames(inspected, semantics);
    const roots: UploadPlanRoot[] = inspected.map((item, index) => ({
      kind: item.kind,
      localPath: item.localPath,
      name: names[index]!,
      size: item.size,
      directory,
      ...(item.identity ? { identity: item.identity } : {}),
    }));
    const id = randomUUID();
    const plan = new UploadPlan(roots, request.policy ?? 'create-new', request.onDirectoryCreated);
    this.plans.set(id, { owner, plan, standalone: false });
    return {
      id,
      sourcePath: commonLocalParent(inspected.map((item) => item.localPath)),
      items: plan.roots,
      ...(needsValidation && request.deferValidation
        ? { needsValidation: { requireCreateDirectory: hasDirectory } }
        : {}),
    };
  }

  private ownedPlan(owner: number, id: string): UploadPlanRecord {
    const record = this.plans.get(id);
    if (!record || record.owner !== owner) throw new StorageError('InvalidArgument');
    return record;
  }
}
