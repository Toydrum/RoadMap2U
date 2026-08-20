import { describe, expect, it } from 'vitest';
import { CheckIn, TimerSession, Tree, TreeNode } from '../../core/db/schema';
import { pickAt, resolveThread, suggestionPool } from './suggest';

/** Minimal fixture builders — only what the ranker reads. */
let seq = 0;
function tree(partial: Partial<Tree> = {}): Tree {
  const id = partial.id ?? `tree-${++seq}`;
  return {
    id,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 1,
    deletedAt: null,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
    ...partial,
  };
}
function node(treeId: string, partial: Partial<TreeNode> = {}): TreeNode {
  const id = partial.id ?? `node-${++seq}`;
  return {
    id,
    createdAt: 1000,
    updatedAt: 1000,
    rev: 1,
    deletedAt: null,
    treeId,
    parentId: null,
    title: id,
    note: '',
    status: 'growing',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    trigger: null,
    ...partial,
  };
}

/** Wire a small forest into the ranker's input shape. */
function world(trees: Tree[], nodes: TreeNode[]) {
  const nodesByTree = new Map<string, TreeNode[]>();
  const nodesById = new Map<string, TreeNode>();
  for (const n of nodes) {
    nodesById.set(n.id, n);
    if (!n.archivedAt) {
      const list = nodesByTree.get(n.treeId) ?? [];
      list.push(n);
      nodesByTree.set(n.treeId, list);
    }
  }
  const childrenOf = (parent: TreeNode) =>
    nodes.filter((n) => n.parentId === parent.id && !n.archivedAt).sort((a, b) => a.order - b.order);
  return { nodesByTree, nodesById, childrenOf };
}

const NO_SESSIONS: TimerSession[] = [];
const NO_CHECKINS: CheckIn[] = [];

describe('suggestionPool — bucket law', () => {
  it("never suggests resting/achieved/branched, and today's intentions lead", () => {
    const t = tree();
    const resting = node(t.id, { status: 'resting' });
    const achieved = node(t.id, { status: 'achieved' });
    const branched = node(t.id, { status: 'branched' });
    const fresh = node(t.id, { status: 'growing', updatedAt: 9000 });
    const chosen = node(t.id, { status: 'seed', updatedAt: 1 });
    const w = world([t], [resting, achieved, branched, fresh, chosen]);
    const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById, [chosen.id]);
    expect(pool[0].node.id).toBe(chosen.id);
    expect(pool[0].kind).toBe('today');
    const ids = pool.map((s) => s.node.id);
    expect(ids).not.toContain(resting.id);
    expect(ids).not.toContain(achieved.id);
    expect(ids).not.toContain(branched.id);
  });

  it('cuando-entonces outranks sunlit; sunlit outranks ambient freshness', () => {
    const t = tree();
    const ambient = node(t.id, { updatedAt: 9999 });
    const sunlit = node(t.id, { priority: 'sunlit', updatedAt: 5 });
    const twig = node(t.id, { trigger: 'cuando me sirva el café', updatedAt: 1 });
    const w = world([t], [ambient, sunlit, twig]);
    const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById);
    expect(pool[0].node.id).toBe(twig.id);
    expect(pool[1].node.id).toBe(sunlit.id);
  });

  it('shade sorts last in the ambient buckets — but never out of the pool', () => {
    const t = tree();
    const shaded = node(t.id, { priority: 'shade', updatedAt: 9999 });
    const steady = node(t.id, { updatedAt: 5 });
    const w = world([t], [shaded, steady]);
    const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById);
    expect(pool[0].node.id).toBe(steady.id);
    expect(pool.map((s) => s.node.id)).toContain(shaded.id);
  });
});

describe('suggestionPool — regadera bajita', () => {
  it('floats CHILD leaves, flags them, and keeps a bare TOP-LEVEL goal as big', () => {
    const t = tree();
    const bareGoal = node(t.id, { updatedAt: 9999 }); // freshest, no children, parentId null
    const parent = node(t.id, { updatedAt: 100 });
    const pasito = node(t.id, { parentId: parent.id, updatedAt: 50 });
    const w = world([t], [bareGoal, parent, pasito]);
    const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById, [], 'bajita');
    expect(pool[0].node.id).toBe(pasito.id);
    expect(pool[0].lowEnergy).toBe(true);
    // the bare goal is NOT small — it must sort after the pasito
    const bareIdx = pool.findIndex((s) => s.node.id === bareGoal.id);
    expect(bareIdx).toBeGreaterThan(0);
    expect(pool[bareIdx].lowEnergy).toBeUndefined();
  });

  it('explicit now (today) still outranks the low-energy float', () => {
    const t = tree();
    const bigToday = node(t.id);
    const parent = node(t.id);
    const pasito = node(t.id, { parentId: parent.id });
    const w = world([t], [bigToday, parent, pasito]);
    const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById, [bigToday.id], 'bajita');
    expect(pool[0].node.id).toBe(bigToday.id);
  });

  it('no energy → identical pool to the default', () => {
    const t = tree();
    const a = node(t.id, { updatedAt: 300 });
    const parent = node(t.id, { updatedAt: 200 });
    const pasito = node(t.id, { parentId: parent.id, updatedAt: 100 });
    const w = world([t], [a, parent, pasito]);
    const base = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById);
    const withNull = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById, [], null);
    expect(withNull.map((s) => s.node.id)).toEqual(base.map((s) => s.node.id));
  });
});

describe('pickAt — the «Otra idea» cycle', () => {
  const t = tree();
  const nodes = [node(t.id, { updatedAt: 30 }), node(t.id, { updatedAt: 20 }), node(t.id, { updatedAt: 10 })];
  const w = world([t], nodes);
  const pool = suggestionPool([t], w.nodesByTree, w.childrenOf, NO_SESSIONS, NO_CHECKINS, w.nodesById);

  it('offset 0 is ALWAYS the ranked best (the reason line stays truthful)', () => {
    expect(pickAt(pool, 0, '2026-07-12')!.node.id).toBe(pool[0].node.id);
  });

  it('a full cycle visits every idea exactly once and returns home', () => {
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) seen.add(pickAt(pool, i, '2026-07-12')!.node.id);
    expect(seen.size).toBe(pool.length);
    expect(pickAt(pool, pool.length, '2026-07-12')!.node.id).toBe(pool[0].node.id);
  });

  it('the walk is deterministic within a day', () => {
    expect(pickAt(pool, 1, '2026-07-12')!.node.id).toBe(pickAt(pool, 1, '2026-07-12')!.node.id);
  });

  it('empty pool yields null; single-item pool always yields it', () => {
    expect(pickAt([], 3, '2026-07-12')).toBeNull();
    expect(pickAt([pool[0]], 7, '2026-07-12')!.node.id).toBe(pool[0].node.id);
  });
});

describe('resolveThread', () => {
  it('freshest wins across session/checkin/pointer, and archived targets are skipped', () => {
    const t = tree();
    const a = node(t.id);
    const b = node(t.id);
    const gone = node(t.id, { archivedAt: 123 });
    const w = world([t], [a, b, gone]);
    const sessions: TimerSession[] = [
      { id: 's1', createdAt: 0, updatedAt: 0, rev: 1, deletedAt: null, nodeId: a.id, startedAt: 100, plannedMinutes: 10, endedAt: 200, note: '' },
    ];
    const checkins: CheckIn[] = [
      { id: 'c1', createdAt: 300, updatedAt: 300, rev: 1, deletedAt: null, feeling: 'calm', note: '', treeId: t.id, nodeId: b.id },
      { id: 'c2', createdAt: 400, updatedAt: 400, rev: 1, deletedAt: null, feeling: 'calm', note: '', treeId: t.id, nodeId: gone.id },
    ];
    const thread = resolveThread([t], w.nodesById, sessions, checkins);
    // c2 targets an archived node → invalid; c1 (300) beats the session (200)
    expect(thread!.node.id).toBe(b.id);
    expect(thread!.source).toBe('checkin');
  });
});
