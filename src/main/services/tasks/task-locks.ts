import type { OperationContext } from '@main/storage/core/contracts';
import type { ResourceLockSet } from '@main/tasks/conflict-ledger';
import { entryKey, type EntryRef, type SpaceSemantics } from '@shared/storage';

export interface TargetLockFacts {
  spaceSemantics: (ref: EntryRef) => Promise<SpaceSemantics | undefined>;
  ancestorLocators: (
    ref: EntryRef,
    context?: OperationContext,
  ) => Promise<readonly string[] | undefined>;
}

export function slotConflictKey(parent: EntryRef, name: string, caseInsensitive = false): string {
  const normalized = caseInsensitive ? name.toLowerCase() : name;
  return `slot:${entryKey(parent)}/${normalized}`;
}

export async function resolveTargetLockKeys(
  facts: TargetLockFacts,
  parent: EntryRef,
  targetNames: readonly string[],
  context?: OperationContext,
): Promise<ResourceLockSet> {
  const semantics = await facts.spaceSemantics(parent);
  if (semantics?.allowsDuplicateNames) {
    return { exclusive: [], shared: [] };
  }
  const caseInsensitive = semantics?.caseSensitive === false;
  const exclusive = targetNames.map((name) => slotConflictKey(parent, name, caseInsensitive));

  const shared = new Set<string>([entryKey(parent)]);
  const ancestors = await facts.ancestorLocators(parent, context).catch(() => undefined);
  if (ancestors) {
    for (const locator of ancestors) {
      shared.add(entryKey({ ...parent, locator }));
    }
  }
  return { exclusive, shared: [...shared] };
}
