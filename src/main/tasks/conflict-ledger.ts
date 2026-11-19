/** Tracks active task and group resource locks to serialize conflicting operations. */
export class TaskConflictLedger {
  private readonly taskKeys = new Map<number, readonly string[]>();
  private readonly groupKeys = new Map<number, readonly string[]>();

  hasConflicts(keys: readonly string[], ownGroup?: number): boolean {
    if (keys.length === 0) return false;
    for (const active of this.taskKeys.values()) {
      if (keys.some((key) => active.includes(key))) return true;
    }
    for (const [groupId, resources] of this.groupKeys) {
      if (groupId !== ownGroup && keys.some((key) => resources.includes(key))) return true;
    }
    return false;
  }

  reserveTask(taskId: number, keys: readonly string[]): void {
    this.taskKeys.set(taskId, keys);
  }

  releaseTask(taskId: number): void {
    this.taskKeys.delete(taskId);
  }

  reserveGroup(groupId: number, resources: readonly string[]): void {
    this.groupKeys.set(groupId, resources);
  }

  releaseGroup(groupId: number): void {
    this.groupKeys.delete(groupId);
  }
}
