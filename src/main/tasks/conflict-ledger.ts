/** Tracks active task and group resource locks to reject conflicting operations. */
export class TaskConflictLedger {
  private readonly taskKeys = new Map<number, readonly string[]>();
  private readonly groupKeys = new Map<number, readonly string[]>();
  private readonly taskOwners = new Map<string, Set<number>>();
  private readonly groupOwners = new Map<string, Set<number>>();

  hasConflicts(keys: readonly string[], ownGroup?: number): boolean {
    for (const key of keys) {
      if ((this.taskOwners.get(key)?.size ?? 0) > 0) return true;
      const groups = this.groupOwners.get(key);
      if (!groups) continue;
      if (groups.size > (ownGroup !== undefined && groups.has(ownGroup) ? 1 : 0)) return true;
    }
    return false;
  }

  reserveTask(taskId: number, keys: readonly string[]): void {
    this.releaseTask(taskId);
    const unique = [...new Set(keys)];
    this.taskKeys.set(taskId, unique);
    for (const key of unique) {
      let owners = this.taskOwners.get(key);
      if (!owners) {
        owners = new Set();
        this.taskOwners.set(key, owners);
      }
      owners.add(taskId);
    }
  }

  releaseTask(taskId: number): void {
    const keys = this.taskKeys.get(taskId);
    if (!keys) return;
    this.taskKeys.delete(taskId);
    for (const key of keys) {
      const owners = this.taskOwners.get(key);
      if (!owners) continue;
      owners.delete(taskId);
      if (owners.size === 0) this.taskOwners.delete(key);
    }
  }

  reserveGroup(groupId: number, resources: readonly string[]): void {
    this.releaseGroup(groupId);
    const unique = [...new Set(resources)];
    this.groupKeys.set(groupId, unique);
    for (const key of unique) {
      let owners = this.groupOwners.get(key);
      if (!owners) {
        owners = new Set();
        this.groupOwners.set(key, owners);
      }
      owners.add(groupId);
    }
  }

  releaseGroup(groupId: number): void {
    const resources = this.groupKeys.get(groupId);
    if (!resources) return;
    this.groupKeys.delete(groupId);
    for (const key of resources) {
      const owners = this.groupOwners.get(key);
      if (!owners) continue;
      owners.delete(groupId);
      if (owners.size === 0) this.groupOwners.delete(key);
    }
  }
}
