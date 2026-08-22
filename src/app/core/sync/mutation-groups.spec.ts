import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../api/contracts';
import { newSyncBase, type TreeNode } from '../db/schema';
import { buildSyncMutationGroups, type MutationMembership } from './mutation-groups';

function record(id: string, rev = 1, updatedAt = 1_800_000_000_000): SyncRecord {
  const node: TreeNode = {
    ...newSyncBase(1_800_000_000_000),
    id,
    rev,
    updatedAt,
    treeId: 'tree-a',
    parentId: 'heart-a',
    title: `private-${id}`,
    note: `private-note-${id}`,
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
  };
  return { store: 'nodes', record: node };
}

describe('v2 mutation group builder', () => {
  it('keeps one logical write together without deriving ids from private content', () => {
    const records = [record('node-b'), record('node-a')];
    const memberships: MutationMembership[] = [
      {
        id: 'mg-atomic',
        recordRefs: [
          { store: 'nodes', id: 'node-a' },
          { store: 'nodes', id: 'node-b' },
        ],
      },
    ];

    const groups = buildSyncMutationGroups(records, memberships);

    expect(groups).toEqual([
      {
        id: 'mg-atomic',
        expectedCount: 2,
        records: [record('node-a'), record('node-b')],
      },
    ]);
    expect(JSON.stringify(groups.map((group) => group.id))).not.toMatch(/private|note/);
  });

  it('splits a large import deterministically into contract-safe groups', () => {
    const records = Array.from({ length: 45 }, (_, index) => record(`node-${index}`));
    const memberships: MutationMembership[] = [
      {
        id: 'mg-import',
        recordRefs: records.map(({ store, record }) => ({ store, id: record.id })),
      },
    ];

    const first = buildSyncMutationGroups(records, memberships);
    const second = buildSyncMutationGroups([...records].reverse(), memberships);

    expect(first.map((group) => group.expectedCount)).toEqual([20, 20, 5]);
    expect(first.map((group) => group.id)).toEqual([
      'mg-import:1of3',
      'mg-import:2of3',
      'mg-import:3of3',
    ]);
    expect(new Set(first.map((group) => group.id)).size).toBe(first.length);
    const assignedRefs = first.flatMap((group) =>
      group.records.map((entry) => `${entry.store}:${entry.record.id}`),
    );
    expect(new Set(assignedRefs).size).toBe(records.length);
    expect(second).toEqual(first);
  });

  it('keeps ungrouped legacy dirty records independently retryable', () => {
    const groups = buildSyncMutationGroups([record('node-b'), record('node-a')], []);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.expectedCount === 1)).toBe(true);
    expect(groups.flatMap((group) => group.records).map((entry) => entry.record.id)).toEqual([
      'node-a',
      'node-b',
    ]);
  });

  it('keeps a legacy retry idempotent per record version and rotates it after an edit', () => {
    const first = buildSyncMutationGroups([record('node-a', 4, 100)], [])[0].id;
    const retry = buildSyncMutationGroups([record('node-a', 4, 100)], [])[0].id;
    const edited = buildSyncMutationGroups([record('node-a', 5, 101)], [])[0].id;

    expect(retry).toBe(first);
    expect(edited).not.toBe(first);
  });
});
