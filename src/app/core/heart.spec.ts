import { describe, expect, it } from 'vitest';
import { TreeNode } from './db/schema';
import { heartIds, heartOf, isContainerHeart, isRoot, treeComplete } from './heart';

function node(id: string, fields: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    rev: 1,
    deletedAt: null,
    treeId: 't1',
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
    ...fields,
  } as TreeNode;
}

const byParent = (nodes: TreeNode[]) => (n: TreeNode) =>
  nodes.filter((c) => c.parentId === n.id);

describe('heartOf — the first visible root, deterministically', () => {
  it('picks the lowest order; createdAt then id break ties', () => {
    const a = node('b-later', { order: 10, createdAt: 5 });
    const b = node('a-earlier', { order: 10, createdAt: 2 });
    expect(heartOf([a, b])?.id).toBe('a-earlier');
    const c = node('zz', { order: 10, createdAt: 2 });
    expect(heartOf([a, c])?.id).toBe('zz'); // createdAt wins over id order
    expect(heartOf([node('m', { order: 20 }), node('n', { order: 10 })])?.id).toBe('n');
    expect(heartOf([])).toBeNull();
  });

  it('legacy multi-root: extra roots are NOT the heart', () => {
    const heart = node('first', { order: 10 });
    const extra = node('extra', { order: 20 });
    const map = new Map([['t1', [heart, extra]]]);
    const ids = heartIds(map);
    expect(ids.has('first')).toBe(true);
    expect(ids.has('extra')).toBe(false);
  });
});

describe('isContainerHeart — with ramitas = container, bare = the goal itself', () => {
  it('needs both the heart identity and at least one child', () => {
    const heart = node('h');
    const ids = new Set(['h']);
    expect(isContainerHeart(heart, ids, 2)).toBe(true);
    expect(isContainerHeart(heart, ids, 0)).toBe(false); // bare goal stays a door
    expect(isContainerHeart(node('x', { parentId: null, order: 30 }), ids, 2)).toBe(false);
  });
  it('isRoot is the established predicate', () => {
    expect(isRoot(node('r'))).toBe(true);
    expect(isRoot(node('c', { parentId: 'r' }))).toBe(false);
  });
});

describe('treeComplete — «cuando las ramitas estén completas»', () => {
  const heart = node('h');
  it('true when every visible descendant is achieved/branched (recursive)', () => {
    const kids = [
      node('a', { parentId: 'h', status: 'achieved', achievedAt: 1 }),
      node('b', { parentId: 'h', status: 'branched', branchedAt: 1 }),
      node('b1', { parentId: 'b', status: 'achieved', achievedAt: 1 }),
    ];
    expect(treeComplete(heart, byParent(kids))).toBe(true);
  });
  it('an open or RESTING ramita blocks (pause ≠ finished)', () => {
    expect(treeComplete(heart, byParent([node('a', { parentId: 'h', status: 'seed' })]))).toBe(false);
    expect(treeComplete(heart, byParent([node('a', { parentId: 'h', status: 'resting' })]))).toBe(false);
  });
  it('a breathing ritual blocks — even bloomed-this-period', () => {
    const ritual = node('r', { parentId: 'h', status: 'achieved', achievedAt: 1, repeats: 'daily' });
    expect(treeComplete(heart, byParent([ritual]))).toBe(false);
  });
  it('counts a legacy spiral on a separate visible root when checking closure', () => {
    const completeBranch = node('a', { parentId: 'h', status: 'achieved', achievedAt: 1 });
    const spiral = node('r', { status: 'achieved', repeats: 'daily' });
    expect(treeComplete(heart, byParent([completeBranch]), [heart, spiral])).toBe(false);
    expect(treeComplete(heart, byParent([completeBranch]), [heart, { ...spiral, repeats: null }])).toBe(true);
  });
  it('a leftover cadence on a BRANCHED node is inert', () => {
    const branched = node('b', { parentId: 'h', status: 'branched', branchedAt: 1, repeats: 'daily' });
    expect(treeComplete(heart, byParent([branched]))).toBe(true);
  });
  it('no descendants = not complete (a bare heart never offers closure)', () => {
    expect(treeComplete(heart, byParent([]))).toBe(false);
  });
  it('a BRANCHED heart never offers — revertBranch is the only exit (0.0.115)', () => {
    const branched = node('h', { status: 'branched', branchedAt: 1 });
    expect(treeComplete(branched, byParent([node('a', { parentId: 'h', status: 'achieved', achievedAt: 1 })]))).toBe(false);
  });
  it("the heart's OWN cadence blocks — the sweep would un-bloom the tree overnight (0.0.115)", () => {
    const ritualHeart = node('h', { repeats: 'daily' });
    expect(treeComplete(ritualHeart, byParent([node('a', { parentId: 'h', status: 'achieved', achievedAt: 1 })]))).toBe(false);
  });
  it('an already-bloomed heart never re-offers', () => {
    const bloomed = node('h', { status: 'achieved', achievedAt: 1 });
    expect(treeComplete(bloomed, byParent([node('a', { parentId: 'h', status: 'achieved', achievedAt: 1 })]))).toBe(false);
  });
});
