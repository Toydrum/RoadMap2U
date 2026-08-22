import { describe, expect, it } from 'vitest';
import {
  PREPAYMENT_PLAN_CATALOG,
  createFreeAccessSummary,
  type AccessSummary,
} from '../api/contracts';
import { type Tree, type TreeNode, newSyncBase } from '../db/schema';
import {
  countQuotaUsage,
  preflightCreateTree,
  preflightImport,
  preflightPlantBranches,
  preflightRestoreBranches,
  preflightRestoreTree,
  preflightSeed,
  type QuotaSnapshot,
} from './quota-policy';

const NOW = 1_800_000_000_000;

function tree(id: string, overrides: Partial<Tree> = {}): Tree {
  return {
    ...newSyncBase(NOW),
    id,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: `${id}-heart`,
    heartId: `${id}-heart`,
    archivedAt: null,
    ...overrides,
  };
}

function node(id: string, treeId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    ...newSyncBase(NOW),
    id,
    treeId,
    parentId: `${treeId}-heart`,
    title: id,
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    ...overrides,
  };
}

function heart(treeId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return node(`${treeId}-heart`, treeId, { parentId: null, ...overrides });
}

function premium(): AccessSummary {
  return {
    ...createFreeAccessSummary(NOW),
    effectivePlanKey: 'premium',
    activeSources: [{ kind: 'sponsored', sourceId: 'demo', planKey: 'premium', validUntil: null }],
    limits: { ...PREPAYMENT_PLAN_CATALOG.plans.premium.limits },
    capabilities: { ...PREPAYMENT_PLAN_CATALOG.plans.premium.capabilities },
    revision: 2,
  };
}

function snapshot(
  trees: Tree[],
  nodes: TreeNode[],
  access: AccessSummary = createFreeAccessSummary(NOW),
  leaseState: QuotaSnapshot['leaseState'] = 'valid',
): QuotaSnapshot {
  return { trees, nodes, access, leaseState };
}

describe('quota usage', () => {
  it('counts only active trees and visible branches, excluding exactly a valid heart', () => {
    const oak = tree('oak');
    const asleep = tree('asleep', { archivedAt: NOW });
    const usage = countQuotaUsage(
      snapshot(
        [oak, asleep, tree('gone', { deletedAt: NOW })],
        [
          heart('oak'),
          node('extra-root', 'oak', { parentId: null, status: 'achieved' }),
          node('resting', 'oak', { status: 'resting' }),
          node('branched', 'oak', { status: 'branched' }),
          node('archived', 'oak', { archivedAt: NOW }),
          node('deleted', 'oak', { deletedAt: NOW }),
          heart('asleep'),
          node('sleep-branch', 'asleep'),
        ],
      ),
    );

    expect(usage).toEqual({
      activeTrees: 1,
      visibleBranchesByTree: { oak: 3 },
      drift: [],
    });
  });

  it.each([
    ['missing id', tree('oak', { heartId: null }), [heart('oak')], 2],
    ['missing record', tree('oak'), [], 1],
    ['foreign tree', tree('oak'), [heart('other', { id: 'oak-heart' })], 1],
    ['non-root', tree('oak'), [heart('oak', { parentId: 'parent' })], 2],
  ])('fails closed for an invalid heart: %s', (_name, oak, nodes, counted) => {
    const usage = countQuotaUsage(snapshot([oak], [...nodes, node('branch', 'oak')]));

    expect(usage.visibleBranchesByTree).toEqual({ oak: counted });
    expect(usage.drift).toEqual(
      expect.arrayContaining([{ reason: 'INVALID_HEART', treeId: 'oak' }]),
    );
  });
});

describe('quota operation preflights', () => {
  it('allows the second Free tree and rejects the third before either write', () => {
    const first = tree('first');
    const second = tree('second');
    const third = tree('third');

    expect(
      preflightCreateTree(snapshot([first], [heart('first')]), second, heart('second')),
    ).toMatchObject({
      allowed: true,
      projected: { activeTrees: 2 },
    });
    expect(
      preflightCreateTree(
        snapshot([first, second], [heart('first'), heart('second')]),
        third,
        heart('third'),
      ),
    ).toEqual({
      allowed: false,
      reason: 'ACTIVE_TREE_LIMIT',
      current: 2,
      projected: 3,
      limit: 2,
    });
  });

  it('requires an exact visible root heart in the same create preflight', () => {
    const newborn = tree('newborn');

    expect(preflightCreateTree(snapshot([], []), newborn, heart('other'))).toEqual({
      allowed: false,
      reason: 'INVALID_HEART',
      treeId: 'newborn',
    });
  });

  it('enforces 10 visible Free branches for single and batch planting', () => {
    const oak = tree('oak');
    const nine = Array.from({ length: 9 }, (_, index) => node(`b${index}`, 'oak'));
    const state = snapshot([oak], [heart('oak'), ...nine]);

    expect(preflightPlantBranches(state, 'oak', 1)).toMatchObject({ allowed: true });
    expect(preflightPlantBranches(state, 'oak', 2)).toEqual({
      allowed: false,
      reason: 'VISIBLE_BRANCH_LIMIT',
      treeId: 'oak',
      current: 9,
      projected: 11,
      limit: 10,
    });
  });

  it('validates the complete visible branch total when restoring a tree', () => {
    const archived = tree('oak', { archivedAt: NOW });
    const branches = Array.from({ length: 11 }, (_, index) => node(`b${index}`, 'oak'));

    expect(preflightRestoreTree(snapshot([archived], [heart('oak'), ...branches]), 'oak')).toEqual({
      allowed: false,
      reason: 'VISIBLE_BRANCH_LIMIT',
      treeId: 'oak',
      current: 0,
      projected: 11,
      limit: 10,
    });
  });

  it('counts only branches that become visible in an atomic restore and never counts the heart', () => {
    const oak = tree('oak');
    const visible = Array.from({ length: 8 }, (_, index) => node(`b${index}`, 'oak'));
    const archived = [
      node('restore-1', 'oak', { archivedAt: NOW }),
      node('restore-2', 'oak', { archivedAt: NOW }),
      heart('oak', { archivedAt: NOW }),
    ];
    const state = snapshot([oak], [...visible, ...archived]);

    expect(preflightRestoreBranches(state, archived)).toMatchObject({
      allowed: true,
      projected: { visibleBranchesByTree: { oak: 10 } },
    });
    expect(
      preflightRestoreBranches(state, [...archived, node('restore-3', 'oak', { archivedAt: NOW })]),
    ).toMatchObject({ allowed: false, reason: 'VISIBLE_BRANCH_LIMIT', projected: 11 });
  });

  it('allows Premium commercial capacity but blocks all growth after the offline lease expires', () => {
    const oak = tree('oak');
    const many = Array.from({ length: 20 }, (_, index) => node(`b${index}`, 'oak'));

    expect(
      preflightPlantBranches(snapshot([oak], [heart('oak'), ...many], premium()), 'oak', 5),
    ).toMatchObject({
      allowed: true,
    });
    expect(
      preflightPlantBranches(snapshot([oak], [heart('oak')], premium(), 'fallback'), 'oak', 1),
    ).toEqual({ allowed: false, reason: 'ACCESS_LEASE_REQUIRED' });
  });

  it('allows a downgraded forest to remain over quota while an operation only reduces it', () => {
    const oak = tree('oak');
    const twelve = Array.from({ length: 12 }, (_, index) => node(`b${index}`, 'oak'));
    const state = snapshot([oak], [heart('oak'), ...twelve]);

    expect(preflightImport(state, [oak], [heart('oak'), ...twelve.slice(0, 11)])).toMatchObject({
      allowed: true,
      projected: { visibleBranchesByTree: { oak: 11 } },
    });
  });

  it('preflights seed/import as one aggregate candidate without mutating either input', () => {
    const current = snapshot([], []);
    const trees = [tree('a'), tree('b'), tree('c')];
    const nodes = trees.flatMap((item) => [heart(item.id), node(`${item.id}-branch`, item.id)]);
    const before = JSON.stringify({ trees, nodes });

    expect(preflightSeed(current, trees.slice(0, 2), nodes.slice(0, 4))).toMatchObject({
      allowed: true,
    });
    expect(preflightImport(current, trees, nodes)).toEqual({
      allowed: false,
      reason: 'ACTIVE_TREE_LIMIT',
      current: 0,
      projected: 3,
      limit: 2,
    });
    expect(JSON.stringify({ trees, nodes })).toBe(before);
  });
});
