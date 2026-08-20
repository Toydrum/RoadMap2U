import type { AccessSummary } from '../api/contracts';
import type { Tree, TreeNode } from '../db/schema';

export type AccessLeaseState = 'valid' | 'fallback';

export interface QuotaSnapshot {
  readonly trees: readonly Tree[];
  readonly nodes: readonly TreeNode[];
  readonly access: AccessSummary;
  readonly leaseState: AccessLeaseState;
}

export type QuotaDrift =
  | { readonly reason: 'INVALID_HEART'; readonly treeId: string }
  | { readonly reason: 'ORPHAN_NODE'; readonly treeId: string; readonly nodeId: string };

export interface QuotaUsage {
  readonly activeTrees: number;
  readonly visibleBranchesByTree: Readonly<Record<string, number>>;
  readonly drift: readonly QuotaDrift[];
}

export type QuotaDecision =
  | { readonly allowed: true; readonly projected: QuotaUsage }
  | { readonly allowed: false; readonly reason: 'ACCESS_LEASE_REQUIRED' }
  | { readonly allowed: false; readonly reason: 'INVALID_HEART'; readonly treeId: string }
  | {
      readonly allowed: false;
      readonly reason: 'ORPHAN_NODE';
      readonly treeId: string;
      readonly nodeId: string;
    }
  | { readonly allowed: false; readonly reason: 'TREE_NOT_FOUND'; readonly treeId: string }
  | { readonly allowed: false; readonly reason: 'TREE_NOT_ACTIVE'; readonly treeId: string }
  | { readonly allowed: false; readonly reason: 'TREE_ALREADY_EXISTS'; readonly treeId: string }
  | { readonly allowed: false; readonly reason: 'TREE_MISMATCH'; readonly nodeId: string }
  | { readonly allowed: false; readonly reason: 'INVALID_BATCH' }
  | {
      readonly allowed: false;
      readonly reason: 'ACTIVE_TREE_LIMIT';
      readonly current: number;
      readonly projected: number;
      readonly limit: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'VISIBLE_BRANCH_LIMIT';
      readonly treeId: string;
      readonly current: number;
      readonly projected: number;
      readonly limit: number;
    };

function uniqueById<T extends { readonly id: string }>(records: readonly T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function activeTrees(trees: readonly Tree[]): Tree[] {
  return uniqueById(trees).filter((tree) => tree.deletedAt === null && tree.archivedAt === null);
}

function validHeart(tree: Tree, nodesById: ReadonlyMap<string, TreeNode>): boolean {
  if (!tree.heartId) return false;
  const candidate = nodesById.get(tree.heartId);
  return Boolean(candidate && candidate.treeId === tree.id && candidate.parentId === null);
}

/** Exact commercial count; this function never mutates or repairs records. */
export function countQuotaUsage(snapshot: Pick<QuotaSnapshot, 'trees' | 'nodes'>): QuotaUsage {
  const allTrees = uniqueById(snapshot.trees);
  const allNodes = uniqueById(snapshot.nodes);
  const treesById = new Map(allTrees.map((tree) => [tree.id, tree]));
  const nodesById = new Map(allNodes.map((node) => [node.id, node]));
  const active = activeTrees(allTrees);
  const activeIds = new Set(active.map((tree) => tree.id));
  const validHeartIds = new Map<string, string>();
  const drift: QuotaDrift[] = [];

  for (const item of active) {
    if (validHeart(item, nodesById)) validHeartIds.set(item.id, item.heartId!);
    else drift.push({ reason: 'INVALID_HEART', treeId: item.id });
  }

  const visibleBranchesByTree: Record<string, number> = Object.fromEntries(
    active.map((tree) => [tree.id, 0]),
  );
  for (const item of allNodes) {
    if (item.deletedAt !== null || item.archivedAt !== null) continue;
    const owningTree = treesById.get(item.treeId);
    if (!owningTree || owningTree.deletedAt !== null) {
      drift.push({ reason: 'ORPHAN_NODE', treeId: item.treeId, nodeId: item.id });
      continue;
    }
    if (!activeIds.has(item.treeId)) continue;
    if (validHeartIds.get(item.treeId) === item.id) continue;
    visibleBranchesByTree[item.treeId] = (visibleBranchesByTree[item.treeId] ?? 0) + 1;
  }

  drift.sort((left, right) => {
    const byTree = left.treeId.localeCompare(right.treeId);
    if (byTree) return byTree;
    return ('nodeId' in left ? left.nodeId : '').localeCompare(
      'nodeId' in right ? right.nodeId : '',
    );
  });
  return { activeTrees: active.length, visibleBranchesByTree, drift };
}

function firstDrift(usage: QuotaUsage): QuotaDecision | null {
  const drift = usage.drift[0];
  if (!drift) return null;
  return drift.reason === 'INVALID_HEART'
    ? { allowed: false, reason: drift.reason, treeId: drift.treeId }
    : {
        allowed: false,
        reason: drift.reason,
        treeId: drift.treeId,
        nodeId: drift.nodeId,
      };
}

function grew(current: QuotaUsage, projected: QuotaUsage): boolean {
  if (projected.activeTrees > current.activeTrees) return true;
  return Object.entries(projected.visibleBranchesByTree).some(
    ([treeId, count]) => count > (current.visibleBranchesByTree[treeId] ?? 0),
  );
}

function evaluate(
  currentSnapshot: QuotaSnapshot,
  candidateTrees: readonly Tree[],
  candidateNodes: readonly TreeNode[],
): QuotaDecision {
  const current = countQuotaUsage(currentSnapshot);
  const projected = countQuotaUsage({ trees: candidateTrees, nodes: candidateNodes });
  const drift = firstDrift(projected);
  if (drift) return drift;
  const hasGrowth = grew(current, projected);
  if (
    hasGrowth &&
    (currentSnapshot.leaseState !== 'valid' || currentSnapshot.access.status !== 'active')
  ) {
    return { allowed: false, reason: 'ACCESS_LEASE_REQUIRED' };
  }

  const treeLimit = currentSnapshot.access.limits.maxActiveTrees;
  if (
    treeLimit !== null &&
    projected.activeTrees > treeLimit &&
    projected.activeTrees > current.activeTrees
  ) {
    return {
      allowed: false,
      reason: 'ACTIVE_TREE_LIMIT',
      current: current.activeTrees,
      projected: projected.activeTrees,
      limit: treeLimit,
    };
  }

  const branchLimit = currentSnapshot.access.limits.maxVisibleBranchesPerTree;
  if (branchLimit !== null) {
    for (const [treeId, count] of Object.entries(projected.visibleBranchesByTree).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (count > branchLimit && count > (current.visibleBranchesByTree[treeId] ?? 0)) {
        return {
          allowed: false,
          reason: 'VISIBLE_BRANCH_LIMIT',
          treeId,
          current: current.visibleBranchesByTree[treeId] ?? 0,
          projected: count,
          limit: branchLimit,
        };
      }
    }
  }
  return { allowed: true, projected };
}

function replaceById<T extends { readonly id: string }>(
  records: readonly T[],
  changes: readonly T[],
): T[] {
  const next = new Map(records.map((record) => [record.id, record]));
  for (const change of changes) next.set(change.id, change);
  return [...next.values()];
}

export function preflightCreateTree(
  snapshot: QuotaSnapshot,
  newborn: Tree,
  heart: TreeNode,
): QuotaDecision {
  if (snapshot.trees.some((current) => current.id === newborn.id)) {
    return { allowed: false, reason: 'TREE_ALREADY_EXISTS', treeId: newborn.id };
  }
  if (
    newborn.deletedAt !== null ||
    newborn.archivedAt !== null ||
    newborn.heartId !== heart.id ||
    heart.treeId !== newborn.id ||
    heart.parentId !== null ||
    heart.deletedAt !== null ||
    heart.archivedAt !== null
  ) {
    return { allowed: false, reason: 'INVALID_HEART', treeId: newborn.id };
  }
  return evaluate(snapshot, [...snapshot.trees, newborn], [...snapshot.nodes, heart]);
}

export function preflightRestoreTree(snapshot: QuotaSnapshot, treeId: string): QuotaDecision {
  const current = snapshot.trees.find((tree) => tree.id === treeId);
  if (!current || current.deletedAt !== null) {
    return { allowed: false, reason: 'TREE_NOT_FOUND', treeId };
  }
  const restored = { ...current, archivedAt: null };
  return evaluate(snapshot, replaceById(snapshot.trees, [restored]), snapshot.nodes);
}

export function preflightPlantBranches(
  snapshot: QuotaSnapshot,
  treeId: string,
  count: number,
): QuotaDecision {
  if (!Number.isSafeInteger(count) || count < 0) {
    return { allowed: false, reason: 'INVALID_BATCH' };
  }
  const tree = snapshot.trees.find((candidate) => candidate.id === treeId);
  if (!tree || tree.deletedAt !== null || tree.archivedAt !== null) {
    return { allowed: false, reason: 'TREE_NOT_ACTIVE', treeId };
  }
  const current = countQuotaUsage(snapshot);
  const drift = firstDrift(current);
  if (drift) return drift;
  if (count > 0 && (snapshot.leaseState !== 'valid' || snapshot.access.status !== 'active')) {
    return { allowed: false, reason: 'ACCESS_LEASE_REQUIRED' };
  }
  const projectedCount = (current.visibleBranchesByTree[treeId] ?? 0) + count;
  const limit = snapshot.access.limits.maxVisibleBranchesPerTree;
  if (limit !== null && projectedCount > limit) {
    return {
      allowed: false,
      reason: 'VISIBLE_BRANCH_LIMIT',
      treeId,
      current: current.visibleBranchesByTree[treeId] ?? 0,
      projected: projectedCount,
      limit,
    };
  }
  return {
    allowed: true,
    projected: {
      ...current,
      visibleBranchesByTree: {
        ...current.visibleBranchesByTree,
        [treeId]: projectedCount,
      },
    },
  };
}

export function preflightRestoreBranches(
  snapshot: QuotaSnapshot,
  records: readonly TreeNode[],
): QuotaDecision {
  const currentById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  for (const record of records) {
    const current = currentById.get(record.id);
    if (current && current.treeId !== record.treeId) {
      return { allowed: false, reason: 'TREE_MISMATCH', nodeId: record.id };
    }
  }
  const restored = records.map((record) => ({ ...record, deletedAt: null, archivedAt: null }));
  return evaluate(snapshot, snapshot.trees, replaceById(snapshot.nodes, restored));
}

export function preflightSeed(
  snapshot: QuotaSnapshot,
  trees: readonly Tree[],
  nodes: readonly TreeNode[],
): QuotaDecision {
  const duplicateTree = trees.find((tree) =>
    snapshot.trees.some((current) => current.id === tree.id),
  );
  if (duplicateTree) {
    return { allowed: false, reason: 'TREE_ALREADY_EXISTS', treeId: duplicateTree.id };
  }
  return evaluate(snapshot, [...snapshot.trees, ...trees], [...snapshot.nodes, ...nodes]);
}

export function preflightImport(
  snapshot: QuotaSnapshot,
  trees: readonly Tree[],
  nodes: readonly TreeNode[],
): QuotaDecision {
  return evaluate(snapshot, trees, nodes);
}
