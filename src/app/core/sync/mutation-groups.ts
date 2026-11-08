import { LIMITS, type SyncMutationGroup, type SyncRecord, type SyncStore } from '../api/contracts';
import { hash } from '../hash';

export interface MutationRecordRef {
  store: SyncStore;
  id: string;
}

export interface MutationMembership {
  id: string;
  recordRefs: readonly MutationRecordRef[];
}

export function syncRecordKey(store: SyncStore, id: string): string {
  return `${store}:${id}`;
}

function sortRecords(records: readonly SyncRecord[]): SyncRecord[] {
  return [...records].sort((a, b) =>
    syncRecordKey(a.store, a.record.id).localeCompare(syncRecordKey(b.store, b.record.id)),
  );
}

/** Compatibility identity for a dirty row that predates client-side group
 * bookkeeping. The same record VERSION retries with the same id; any later
 * edit rotates it. Only structural sync identity participates — never owner,
 * title, note or another payload field. */
function legacyMutationGroupId(entry: SyncRecord): string {
  const { store, record } = entry;
  const canonical = `${store.length}:${store}:${record.id.length}:${record.id}:${record.rev}:${record.updatedAt}`;
  return `mg-legacy-${hash(`a:${canonical}`).toString(36)}-${hash(`b:${canonical}`).toString(36)}`;
}

// The server validates each group against its own rows and committed data.
const RELATIONSHIPS: Record<SyncStore, readonly (readonly [SyncStore, string])[]> = {
  trees: [['nodes', 'heartId'], ['nodes', 'currentNodeId']],
  nodes: [['trees', 'treeId'], ['nodes', 'parentId']],
  checkins: [['trees', 'treeId'], ['nodes', 'nodeId']],
  sessions: [['nodes', 'nodeId']],
  harvests: [['trees', 'treeId'], ['nodes', 'nodeId'], ['preserves', 'preserveId']],
  preserves: [['trees', 'treeId']],
};

function orderByDependencies(groups: readonly SyncMutationGroup[]): SyncMutationGroup[] {
  const byRecord = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const entry of group.records) byRecord.set(syncRecordKey(entry.store, entry.record.id), index);
  });
  const dependencies = groups.map((group, index) => {
    const required = new Set<number>();
    for (const entry of group.records) {
      const record = entry.record as unknown as Readonly<Record<string, unknown>>;
      for (const [store, field] of RELATIONSHIPS[entry.store]) {
        const id = record[field];
        if (typeof id !== 'string') continue;
        const dependency = byRecord.get(syncRecordKey(store, id));
        if (dependency !== undefined && dependency !== index) required.add(dependency);
      }
    }
    return required;
  });

  // With edges pointing to requirements, Tarjan emits each component after
  // its dependencies. A new tree, its current node and that node's ancestors
  // may need the same transaction, even if they came from separate gestures.
  const order: SyncMutationGroup[] = [];
  const visited = new Map<number, number>();
  const active = new Set<number>();
  const stack: number[] = [];
  function enter(index: number) {
    const position = visited.size;
    visited.set(index, position);
    active.add(index);
    stack.push(index);
    return { index, position, oldest: position, required: dependencies[index].values() };
  }

  function emitComponent(index: number): void {
    const component: number[] = [];
    let member: number;
    do {
      member = stack.pop()!;
      active.delete(member);
      component.push(member);
    } while (member !== index);
    const related = component.sort((a, b) => a - b).map((part) => groups[part]);
    const size = related.reduce((count, group) => count + group.expectedCount, 0);
    if (related.length === 1 || size > LIMITS.syncMutationGroupMax) {
      // An oversized cycle cannot be made atomic by changing the order.
      // Preserve its original groups for the existing conflict/retry path.
      order.push(...related);
    } else {
      const records = sortRecords(related.flatMap((group) => group.records));
      // Existing IDs remain bound to their original payloads. A merge needs
      // a separate ID derived only from operation and record version identity.
      const identity = JSON.stringify([
        related.map((group) => group.id),
        records.map(({ store, record }) => [store, record.id, record.rev, record.updatedAt]),
      ]);
      order.push({
        id: `mg-related-${hash(`a:${identity}`).toString(36)}-${hash(`b:${identity}`).toString(36)}`,
        expectedCount: size,
        records,
      });
    }
  }
  for (let index = 0; index < groups.length; index++) {
    if (visited.has(index)) continue;
    const traversal = [enter(index)];
    while (traversal.length) {
      const frame = traversal.at(-1)!;
      const dependency = frame.required.next();
      if (!dependency.done) {
        const seen = visited.get(dependency.value);
        if (seen === undefined) traversal.push(enter(dependency.value));
        else if (active.has(dependency.value)) frame.oldest = Math.min(frame.oldest, seen);
        continue;
      }
      traversal.pop();
      if (frame.oldest === frame.position) emitComponent(frame.index);
      const parent = traversal.at(-1);
      if (parent) parent.oldest = Math.min(parent.oldest, frame.oldest);
    }
  }
  return order;
}

/** Builds contract-v2 groups from sanitized pending memberships. Memberships
 * are bookkeeping only: payload records remain the live repo snapshots. A
 * logical write larger than DynamoDB's 20-record boundary is split in stable
 * key order; older dirty rows without membership remain independent so one
 * stale legacy record cannot hold unrelated rows hostage. */
export function buildSyncMutationGroups(
  records: readonly SyncRecord[],
  memberships: readonly MutationMembership[],
): SyncMutationGroup[] {
  const byKey = new Map(
    sortRecords(records).map((entry) => [syncRecordKey(entry.store, entry.record.id), entry]),
  );
  const assigned = new Set<string>();
  const groups: SyncMutationGroup[] = [];

  for (const membership of [...memberships].sort((a, b) => a.id.localeCompare(b.id))) {
    const members = sortRecords(
      membership.recordRefs
        .map((ref) => byKey.get(syncRecordKey(ref.store, ref.id)))
        .filter((entry): entry is SyncRecord => Boolean(entry))
        .filter((entry) => !assigned.has(syncRecordKey(entry.store, entry.record.id))),
    );
    if (!members.length) continue;
    const partCount = Math.ceil(members.length / LIMITS.syncMutationGroupMax);
    for (let index = 0; index < partCount; index += 1) {
      const part = members.slice(
        index * LIMITS.syncMutationGroupMax,
        (index + 1) * LIMITS.syncMutationGroupMax,
      );
      for (const entry of part) assigned.add(syncRecordKey(entry.store, entry.record.id));
      groups.push({
        id: partCount === 1 ? membership.id : `${membership.id}:${index + 1}of${partCount}`,
        expectedCount: part.length,
        records: part,
      });
    }
  }

  for (const entry of sortRecords(records)) {
    const key = syncRecordKey(entry.store, entry.record.id);
    if (assigned.has(key)) continue;
    groups.push({
      id: legacyMutationGroupId(entry),
      expectedCount: 1,
      records: [entry],
    });
  }
  return orderByDependencies(groups);
}

/** Requests cap total records, never split an already-safe mutation group. */
export function chunkMutationGroups(groups: readonly SyncMutationGroup[]): SyncMutationGroup[][] {
  const batches: SyncMutationGroup[][] = [];
  let current: SyncMutationGroup[] = [];
  let count = 0;
  for (const group of groups) {
    if (current.length && count + group.expectedCount > LIMITS.syncPushMax) {
      batches.push(current);
      current = [];
      count = 0;
    }
    current.push(group);
    count += group.expectedCount;
  }
  if (current.length) batches.push(current);
  return batches;
}
