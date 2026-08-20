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
  return groups;
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
