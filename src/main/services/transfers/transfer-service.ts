import { randomUUID } from 'node:crypto';
import { StorageError, throwIfAborted } from '@main/storage/core/errors';
import {
  entryKey,
  type Capabilities,
  type Entry,
  type EntryRef,
  type SpaceSemantics,
} from '@shared/storage';
import type { StorageDirectory } from '../storage/storage-directory';
import { resolveTransferStrategy } from './transfer-compatibility';
import type { TransferExecution, TransferExecutionOptions } from './transfer-execution';
import { allocateTransferNames, normalizeTargetName } from './transfer-names';
import { TransferPlan, type TransferPlanRoot } from './transfer-plan';
import type {
  CommittedTransferFile,
  PreparedTransferBatch,
  PrepareTransferRequest,
  SourceDirectoryCleanupEntry,
  TransferOperations,
  TransferPlanPage,
  TransferRunResult,
  TransferWork,
  TransferWorkRef,
} from './transfer-types';

interface TransferPlanRecord {
  owner: number;
  plan: TransferPlan;
  standalone: boolean;
}

function executionKey(ref: TransferWorkRef): string {
  return `${ref.planId}:${ref.itemId}`;
}

export type PreparedTransferResult =
  | { kind: 'single'; work: TransferWork; conflicts: string[] }
  | { kind: 'batch'; prepared: PreparedTransferBatch };

/** Owns provider-neutral cross-source transfer plans and file executions; scheduling stays in TaskQueue. */
export class TransferService {
  private readonly plans = new Map<string, TransferPlanRecord>();
  private readonly executions = new Map<string, TransferExecution>();
  private readonly preparations = new Set<Promise<PreparedTransferResult>>();
  private readonly ownerEpochs = new Map<number, number>();
  private readonly lifetime = new AbortController();

  constructor(private readonly operations: TransferOperations) {}

  prepare(owner: number, request: PrepareTransferRequest): Promise<PreparedTransferResult> {
    const pending = this.prepareTransfer(owner, request);
    this.preparations.add(pending);
    void pending.finally(() => this.preparations.delete(pending)).catch(() => {});
    return pending;
  }

  confirmPlan(owner: number, planId: string): void {
    this.ownedPlan(owner, planId).plan.confirm();
  }

  discoverDirectory(
    owner: number,
    planId: string,
    itemId: number,
    offset: number,
  ): Promise<TransferPlanPage> {
    const record = this.ownedPlan(owner, planId);
    record.plan.reopen();
    return record.plan.directoryPage(itemId, offset);
  }

  async runWork(
    owner: number,
    ref: TransferWorkRef,
    options: TransferExecutionOptions,
  ): Promise<TransferRunResult> {
    const record = this.ownedPlan(owner, ref.planId);
    const key = executionKey(ref);
    let keepExecution = false;
    try {
      let execution = this.executions.get(key);
      if (!execution) {
        record.plan.reopen();
        const prepared = await record.plan.prepareFile(ref.itemId);
        if (options.signal.aborted) {
          await this.cancelWork(owner, ref);
          return { status: 'cancelled' };
        }
        execution = prepared.execution;
        this.executions.set(key, execution);
      }
      const result = await execution.run(options);
      if (result.status === 'paused') {
        keepExecution = true;
      } else if (result.status === 'completed') {
        record.plan.recordCommittedFile(ref.itemId, result.entry, result.sourceSnapshot);
      }
      return result;
    } catch (error) {
      keepExecution = this.executions.has(key) && this.executions.get(key)?.retryable === false;
      throw error;
    } finally {
      if (!keepExecution) {
        this.executions.delete(key);
        this.finishStandaloneIfIdle(ref.planId);
      }
    }
  }

  pauseWork(owner: number, ref: TransferWorkRef): void {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return;
    this.executions.get(executionKey(ref))?.pause();
  }

  canRetryWork(owner: number, ref: TransferWorkRef): boolean {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return false;
    if (record.plan.getCommittedFile(ref.itemId)) return true;
    return this.executions.get(executionKey(ref))?.retryable ?? true;
  }

  async cancelWork(owner: number, ref: TransferWorkRef): Promise<void> {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return;
    const key = executionKey(ref);
    const execution = this.executions.get(key);
    this.executions.delete(key);
    record.plan.cancelItem(ref.itemId);
    try {
      if (execution) await execution.cancel();
    } finally {
      this.finishStandaloneIfIdle(ref.planId);
    }
  }

  async cancelPlanItem(owner: number, planId: string, itemId: number): Promise<void> {
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) return;
    record.plan.cancelItem(itemId);
    const key = executionKey({ planId, itemId });
    const execution = this.executions.get(key);
    this.executions.delete(key);
    if (execution) await execution.cancel();
  }

  getCommittedFile(owner: number, ref: TransferWorkRef): CommittedTransferFile | undefined {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return undefined;
    return record.plan.getCommittedFile(ref.itemId);
  }

  markSourceDeleted(owner: number, ref: TransferWorkRef): void {
    const record = this.plans.get(ref.planId);
    if (!record || record.owner !== owner) return;
    record.plan.markSourceDeleted(ref.itemId);
  }

  getRemainingSourceDirectories(owner: number, planId: string): SourceDirectoryCleanupEntry[] {
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) return [];
    return record.plan.getRemainingSourceDirectories();
  }

  markSourceDirectoryDeleted(owner: number, planId: string, ref: EntryRef): void {
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) return;
    record.plan.markSourceDirectoryDeleted(ref);
  }

  finishPlan(owner: number, planId: string): void {
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) return;
    record.plan.finish();
  }

  async releaseWork(owner: number, ref: TransferWorkRef): Promise<void> {
    const key = executionKey(ref);
    const execution = this.executions.get(key);
    this.executions.delete(key);
    if (execution) await execution.cancel().catch(() => {});
    const record = this.plans.get(ref.planId);
    if (record?.owner === owner && record.standalone) {
      await this.releasePlan(owner, ref.planId);
    }
  }

  async releasePlan(owner: number, planId: string): Promise<void> {
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) return;
    this.plans.delete(planId);
    await this.cancelPlanExecutions(planId);
    await record.plan.release();
  }

  cancelOwner(owner: number): void {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    for (const [planId, record] of this.plans) {
      if (record.owner !== owner) continue;
      void this.releasePlan(owner, planId).catch(() => {});
    }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    const plans = [...this.plans.entries()];
    await Promise.allSettled([
      ...this.preparations,
      ...plans.map(([planId, record]) => this.releasePlan(record.owner, planId)),
    ]);
    this.plans.clear();
    this.executions.clear();
  }

  private async prepareTransfer(
    owner: number,
    request: PrepareTransferRequest,
  ): Promise<PreparedTransferResult> {
    throwIfAborted(this.lifetime.signal);
    const epoch = this.ownerEpochs.get(owner);
    if (request.entries.length === 0) throw new StorageError('InvalidArgument');

    const targetDir = this.operations.directory(request.targetParent);
    const targetRef = targetDir.ref;
    const [sourceProvider, targetProvider, targetSemantics, targetCapabilities] = await Promise.all(
      [
        this.operations.resolveProvider(request.sourceParent.connectionId),
        this.operations.resolveProvider(targetRef.connectionId),
        targetDir.semantics(),
        targetDir.capabilities({ signal: this.lifetime.signal }),
      ],
    );

    if (targetCapabilities.write?.support === 'unsupported') {
      throw new StorageError('PermissionDenied');
    }

    const uniqueEntries = this.deduplicateAndValidateEntries(
      request.entries,
      request.mode,
      targetCapabilities,
    );
    const allocatedNames = allocateTransferNames(uniqueEntries, targetSemantics);
    for (const name of allocatedNames) {
      const valid =
        (await this.operations.validateEntryName?.(targetRef.connectionId, name)) ?? true;
      if (!valid) throw new StorageError('InvalidArgument');
    }

    const existingMap = targetSemantics?.allowsDuplicateNames
      ? new Map<string, Entry>()
      : await this.listExistingTargets(targetDir, targetSemantics);

    const roots: TransferPlanRoot[] = [];
    const conflicts: string[] = [];
    for (const [index, entry] of uniqueEntries.entries()) {
      const targetName = allocatedNames[index]!;
      const existingTarget = existingMap.get(normalizeTargetName(targetName, targetSemantics));
      if (existingTarget) {
        if (entry.kind === 'file' && existingTarget.kind !== 'file') {
          throw new StorageError('InvalidArgument');
        }
        if (entry.kind === 'directory' && existingTarget.kind !== 'directory') {
          throw new StorageError('InvalidArgument');
        }
        if (entry.kind === 'file') {
          const replaceCompat = resolveTransferStrategy(entry, targetCapabilities, true);
          if (!replaceCompat.supported) throw new StorageError(replaceCompat.code);
        }
        conflicts.push(targetName);
      }
      roots.push({
        entry,
        sourceParent: request.sourceParent,
        targetName,
        existingTarget,
      });
    }

    throwIfAborted(this.lifetime.signal);
    if (this.ownerEpochs.get(owner) !== epoch) throw new StorageError('Cancelled');

    const targetCanonicalKey =
      (await this.operations.canonicalEntryKey?.(targetRef)) ?? entryKey(targetRef);
    const planId = randomUUID();
    const standalone = uniqueEntries.length === 1 && uniqueEntries[0]!.kind === 'file';
    const confirmed = conflicts.length === 0 || request.replace === true;
    const plan = new TransferPlan({
      operations: this.operations,
      mode: request.mode,
      targetRoot: targetDir,
      targetCapabilities,
      targetSemantics,
      roots,
      confirmed,
      initialVisitedKeys: [targetCanonicalKey],
      onDirectoryCreated: request.onDirectoryCreated,
    });
    this.plans.set(planId, { owner, plan, standalone });

    if (standalone) {
      return {
        kind: 'single',
        conflicts,
        work: {
          ref: { planId, itemId: 0 },
          item: plan.roots[0]!,
          mode: request.mode,
          sourceProvider,
          targetProvider,
        },
      };
    }

    return {
      kind: 'batch',
      prepared: {
        id: planId,
        mode: request.mode,
        sourceProvider,
        targetProvider,
        targetParent: targetRef,
        conflicts,
        items: plan.roots,
      },
    };
  }

  private deduplicateAndValidateEntries(
    entries: readonly Entry[],
    mode: PrepareTransferRequest['mode'],
    targetCapabilities: Capabilities,
  ): Entry[] {
    const seen = new Set<string>();
    const unique: Entry[] = [];
    let hasDirectory = false;
    for (const entry of entries) {
      const key = entryKey(entry.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      if (entry.kind === 'directory') {
        hasDirectory = true;
        if (entry.capabilities.list?.support === 'unsupported') {
          throw new StorageError('Unsupported');
        }
      } else if (entry.kind === 'file') {
        const compat = resolveTransferStrategy(entry, targetCapabilities, false);
        if (!compat.supported) throw new StorageError(compat.code);
      } else {
        throw new StorageError('Unsupported');
      }
      if (mode === 'move' && entry.capabilities.remove?.support === 'unsupported') {
        throw new StorageError('Unsupported');
      }
      unique.push(entry);
    }
    if (hasDirectory && targetCapabilities.createDirectory?.support === 'unsupported') {
      throw new StorageError('Unsupported');
    }
    return unique;
  }

  private async listExistingTargets(
    targetDir: StorageDirectory,
    semantics?: SpaceSemantics,
  ): Promise<Map<string, Entry>> {
    const existing = new Map<string, Entry>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      throwIfAborted(this.lifetime.signal);
      const page = await targetDir.list(cursor ? { cursor } : {}, { signal: this.lifetime.signal });
      for (const entry of page.entries) {
        existing.set(normalizeTargetName(entry.name, semantics), entry);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new StorageError('OutcomeUnknown');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return existing;
  }

  private async cancelPlanExecutions(planId: string): Promise<void> {
    const prefix = `${planId}:`;
    const active: TransferExecution[] = [];
    for (const [key, execution] of this.executions) {
      if (key.startsWith(prefix)) {
        this.executions.delete(key);
        active.push(execution);
      }
    }
    await Promise.allSettled(active.map((execution) => execution.cancel()));
  }

  private finishStandaloneIfIdle(planId: string): void {
    const record = this.plans.get(planId);
    if (!record?.standalone) return;
    const prefix = `${planId}:`;
    for (const key of this.executions.keys()) {
      if (key.startsWith(prefix)) return;
    }
    record.plan.finish();
  }

  private ownedPlan(owner: number, planId: string): TransferPlanRecord {
    throwIfAborted(this.lifetime.signal);
    const record = this.plans.get(planId);
    if (!record || record.owner !== owner) throw new StorageError('InvalidArgument');
    return record;
  }
}
