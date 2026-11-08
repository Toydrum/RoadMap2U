import { describe, expect, it } from 'vitest';
import type { SyncRecord } from '../api/contracts';
import { newSyncBase, type Tree, type TreeNode } from '../db/schema';
import { buildSyncMutationGroups, type MutationMembership } from './mutation-groups';

function record(id: string, rev = 1, updatedAt = 1_800_000_000_000, parentId: string | null = 'heart-a'): SyncRecord {
  const node: TreeNode = {
    ...newSyncBase(1_800_000_000_000),
    id,
    rev,
    updatedAt,
    treeId: 'tree-a',
    parentId,
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

function tree(currentNodeId = 'heart-a'): SyncRecord {
  const value: Tree = {
    ...newSyncBase(1_800_000_000_000),
    id: 'tree-a',
    name: 'Private tree',
    accent: 'moss',
    order: 10,
    currentNodeId,
    heartId: 'heart-a',
    archivedAt: null,
  };
  return { store: 'trees', record: value };
}

function membership(id: string, ...records: SyncRecord[]): MutationMembership {
  return { id, recordRefs: records.map((entry) => ({ store: entry.store, id: entry.record.id })) };
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

  it('sends the tree and its heart before pending parent and child groups regardless of ids', () => {
    const owner = tree();
    const heart = record('heart-a', 1, undefined, null);
    const parent = record('parent-a');
    const child = record('child-a', 1, undefined, 'parent-a');
    const checkin: SyncRecord = {
      store: 'checkins',
      record: {
        ...newSyncBase(1_800_000_000_000),
        id: 'checkin-a',
        feeling: 'calm',
        note: '',
        treeId: 'tree-a',
        nodeId: 'child-a',
      },
    };
    const groups = buildSyncMutationGroups([child, checkin, heart, owner, parent], [
      membership('mg-d-tree', owner, heart),
      membership('mg-c-parent', parent),
      membership('mg-b-child', child),
      membership('mg-a-checkin', checkin),
    ]);

    expect(groups.map((group) => group.id)).toEqual([
      'mg-d-tree', 'mg-c-parent', 'mg-b-child', 'mg-a-checkin',
    ]);
  });

  it('keeps the first tree and its current-node chain atomic with stable retry identity', () => {
    const owner = tree('child-a');
    const heart = record('heart-a', 1, undefined, null);
    const parent = record('parent-a');
    const child = record('child-a', 1, undefined, 'parent-a');
    const sibling = record('sibling-a');
    const memberships = [
      membership('mg-new-tree', owner, heart),
      membership('mg-parent', parent),
      membership('mg-child', child),
      membership('mg-sibling', sibling),
    ];
    const records = [child, sibling, heart, owner, parent];
    const [first, second] = buildSyncMutationGroups(records, memberships);
    expect(first.records.map((entry) => entry.record.id).sort()).toEqual([
      'child-a', 'heart-a', 'parent-a', 'tree-a',
    ]);
    expect(first.id).not.toMatch(/mg-new-tree|mg-parent|mg-child|private/i);
    expect(second.id).toBe('mg-sibling');
    expect(buildSyncMutationGroups([...records].reverse(), [...memberships].reverse())).toEqual([first, second]);
    const edited = records.map((entry) =>
      entry === child ? record('child-a', 2, undefined, 'parent-a') : entry,
    );
    expect(buildSyncMutationGroups(edited, memberships)[0].id).not.toBe(first.id);
  });

  it('combines a legacy tree and heart that have no stored membership', () => {
    const records = [tree(), record('heart-a', 1, undefined, null)];
    const groups = buildSyncMutationGroups(records, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].expectedCount).toBe(2);
    expect(buildSyncMutationGroups([...records].reverse(), [])).toEqual(groups);
  });

  it('orders a deep imported branch chain without relying on the call stack', () => {
    const count = 12_000;
    const id = (index: number) => `node-${String(index).padStart(5, '0')}`;
    const records = Array.from({ length: count }, (_, index) =>
      record(id(index), 1, undefined, index + 1 < count ? id(index + 1) : null),
    );
    const groups = buildSyncMutationGroups(records, []);
    expect(groups).toHaveLength(count);
    expect(groups.map((group) => group.records[0].record.id)).toEqual(records.map((entry) => entry.record.id).reverse());
  });
});
