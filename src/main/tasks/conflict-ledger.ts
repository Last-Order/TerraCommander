export interface ResourceLockSet {
  readonly exclusive?: readonly string[] | undefined;
  readonly shared?: readonly string[] | undefined;
}

export type ResourceLocks = readonly string[] | ResourceLockSet;

interface NormalizedLocks {
  readonly exclusive: readonly string[];
  readonly shared: readonly string[];
}

export function normalizeResourceLocks(locks: ResourceLocks | undefined): NormalizedLocks {
  if (!locks) return { exclusive: [], shared: [] };
  if (Array.isArray(locks)) {
    return { exclusive: [...new Set(locks)], shared: [] };
  }
  const set = locks as ResourceLockSet;
  return {
    exclusive: [...new Set(set.exclusive ?? [])],
    shared: [...new Set(set.shared ?? [])],
  };
}

export function mergeResourceLocks(
  first: ResourceLocks | undefined,
  second: ResourceLocks | undefined,
): NormalizedLocks {
  const left = normalizeResourceLocks(first);
  const right = normalizeResourceLocks(second);
  return {
    exclusive: [...new Set([...left.exclusive, ...right.exclusive])],
    shared: [...new Set([...left.shared, ...right.shared])],
  };
}

export interface ConflictCheckOptions {
  ownGroup?: number | undefined;
  ignoreReservation?: string | undefined;
}

/** Tracks active task, group, and pending reservation locks with exclusive/shared modes. */
export class TaskConflictLedger {
  private readonly ownerLocks = new Map<string, NormalizedLocks>();
  private readonly exclusiveOwners = new Map<string, Set<string>>();
  private readonly sharedOwners = new Map<string, Set<string>>();

  hasConflicts(locks: ResourceLocks, options: number | ConflictCheckOptions = {}): boolean {
    const { ownGroup, ignoreReservation } =
      typeof options === 'number' ? { ownGroup: options, ignoreReservation: undefined } : options;
    const normalized = normalizeResourceLocks(locks);

    const isExternal = (owner: string): boolean => {
      if (ownGroup !== undefined && owner === groupOwnerKey(ownGroup)) return false;
      if (ignoreReservation !== undefined && owner === reservationOwnerKey(ignoreReservation)) {
        return false;
      }
      return true;
    };

    const hasExternalOwner = (map: Map<string, Set<string>>, key: string): boolean => {
      const owners = map.get(key);
      if (!owners) return false;
      for (const owner of owners) {
        if (isExternal(owner)) return true;
      }
      return false;
    };

    for (const key of normalized.exclusive) {
      if (hasExternalOwner(this.exclusiveOwners, key) || hasExternalOwner(this.sharedOwners, key)) {
        return true;
      }
    }
    for (const key of normalized.shared) {
      if (hasExternalOwner(this.exclusiveOwners, key)) {
        return true;
      }
    }
    return false;
  }

  reservePending(reservationId: string, locks: ResourceLocks): boolean {
    const owner = reservationOwnerKey(reservationId);
    if (this.ownerLocks.has(owner)) return false;
    if (this.hasConflicts(locks)) return false;
    this.setOwnerLocks(owner, normalizeResourceLocks(locks));
    return true;
  }

  releasePending(reservationId: string): void {
    this.clearOwnerLocks(reservationOwnerKey(reservationId));
  }

  getPendingLocks(reservationId: string): NormalizedLocks | undefined {
    return this.ownerLocks.get(reservationOwnerKey(reservationId));
  }

  transferPendingToTask(
    reservationId: string,
    taskId: number,
    extraLocks?: ResourceLocks,
    ownGroup?: number,
  ): boolean {
    const pending = this.getPendingLocks(reservationId);
    if (!pending) return false;
    const merged = mergeResourceLocks(pending, extraLocks);
    if (this.hasConflicts(merged, { ownGroup, ignoreReservation: reservationId })) return false;
    this.clearOwnerLocks(reservationOwnerKey(reservationId));
    this.setOwnerLocks(taskOwnerKey(taskId), merged);
    return true;
  }

  transferPendingToGroup(
    reservationId: string,
    groupId: number,
    extraLocks?: ResourceLocks,
  ): boolean {
    const pending = this.getPendingLocks(reservationId);
    if (!pending) return false;
    const merged = mergeResourceLocks(pending, extraLocks);
    if (this.hasConflicts(merged, { ignoreReservation: reservationId })) return false;
    this.clearOwnerLocks(reservationOwnerKey(reservationId));
    this.setOwnerLocks(groupOwnerKey(groupId), merged);
    return true;
  }

  reserveTask(taskId: number, locks: ResourceLocks): void {
    this.setOwnerLocks(taskOwnerKey(taskId), normalizeResourceLocks(locks));
  }

  releaseTask(taskId: number): void {
    this.clearOwnerLocks(taskOwnerKey(taskId));
  }

  reserveGroup(groupId: number, locks: ResourceLocks): void {
    this.setOwnerLocks(groupOwnerKey(groupId), normalizeResourceLocks(locks));
  }

  releaseGroup(groupId: number): void {
    this.clearOwnerLocks(groupOwnerKey(groupId));
  }

  private setOwnerLocks(owner: string, locks: NormalizedLocks): void {
    this.clearOwnerLocks(owner);
    if (locks.exclusive.length === 0 && locks.shared.length === 0) return;
    this.ownerLocks.set(owner, locks);
    for (const key of locks.exclusive) addOwner(this.exclusiveOwners, key, owner);
    for (const key of locks.shared) addOwner(this.sharedOwners, key, owner);
  }

  private clearOwnerLocks(owner: string): void {
    const existing = this.ownerLocks.get(owner);
    if (!existing) return;
    this.ownerLocks.delete(owner);
    for (const key of existing.exclusive) removeOwner(this.exclusiveOwners, key, owner);
    for (const key of existing.shared) removeOwner(this.sharedOwners, key, owner);
  }
}

function taskOwnerKey(taskId: number): string {
  return `t:${taskId}`;
}

function groupOwnerKey(groupId: number): string {
  return `g:${groupId}`;
}

function reservationOwnerKey(reservationId: string): string {
  return `r:${reservationId}`;
}

function addOwner(map: Map<string, Set<string>>, key: string, owner: string): void {
  let owners = map.get(key);
  if (!owners) {
    owners = new Set();
    map.set(key, owners);
  }
  owners.add(owner);
}

function removeOwner(map: Map<string, Set<string>>, key: string, owner: string): void {
  const owners = map.get(key);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) map.delete(key);
}
