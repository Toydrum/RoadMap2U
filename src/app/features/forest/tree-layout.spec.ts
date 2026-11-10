import { describe, expect, it } from 'vitest';
import { TreeNode } from '../../core/db/schema';
import { layoutTree } from './tree-layout';

function node(id: string, parentId: string | null, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    deletedAt: null,
    treeId: 't1',
    parentId,
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
    ...extra,
  };
}

/** Build a layout from a flat node list (parentId wires the family). */
function lay(nodes: TreeNode[]) {
  const roots = nodes.filter((n) => n.parentId === null);
  const childrenOf = (n: TreeNode) => nodes.filter((c) => c.parentId === n.id);
  return layoutTree(roots, childrenOf);
}

describe('layoutTree', () => {
  it('gives a dense 59-branch tree vertical room while preserving every parent', () => {
    const nodes = [node('heart', null)];
    for (let i = 0; i < 7; i++) {
      const fan = `fan-${i}`;
      nodes.push(node(fan, 'heart'));
      for (let j = 0; j < 6; j++) {
        const branch = `${fan}-${j}`;
        nodes.push(node(branch, fan));
        if (j === 2 && i > 0 && i < 6) {
          nodes.push(node(`${branch}-a`, branch), node(`${branch}-b`, branch));
        }
      }
    }
    const layout = lay(nodes);
    expect(layout.width / layout.height).toBeLessThan(3.5);
    expect(layout.points).toHaveLength(60);
    for (const p of layout.points) {
      expect(p.parent?.node.id ?? null).toBe(p.node.parentId);
      if (p.parent) expect(p.y).toBeLessThan(p.parent.y);
    }
  });

  it('is deterministic — same ids, same forest, forever', () => {
    const nodes = [node('r', null), node('a', 'r'), node('b', 'r'), node('c', 'a')];
    const one = lay(nodes);
    const two = lay(nodes);
    expect(one.points.map((p) => [p.node.id, p.x, p.y])).toEqual(
      two.points.map((p) => [p.node.id, p.x, p.y]),
    );
  });

  it('mass is the carried leaf count — leaves weigh 1, parents sum', () => {
    // r → a (leaf), b → c (leaf), d (leaf)  ⇒ b carries 2, r carries 3.
    const nodes = [node('r', null), node('a', 'r'), node('b', 'r'), node('c', 'b'), node('d', 'b')];
    const { byId } = lay(nodes);
    expect(byId.get('a')!.mass).toBe(1);
    expect(byId.get('b')!.mass).toBe(2);
    expect(byId.get('r')!.mass).toBe(3);
  });

  it('ordered steps become a chain: links flagged, each carrying the next', () => {
    const nodes = [
      node('r', null, { flow: 'steps' }),
      node('s1', 'r', { order: 10 }),
      node('s2', 'r', { order: 20 }),
      node('s3', 'r', { order: 30 }),
    ];
    const { byId } = lay(nodes);
    expect(byId.get('s1')!.chain).toBe(true);
    expect(byId.get('s1')!.chainNextId).toBe('s2');
    expect(byId.get('s2')!.chainNextId).toBe('s3');
    expect(byId.get('s3')!.chainNextId).toBeUndefined();
    // The chain climbs: each step sits higher (smaller y) than the last.
    expect(byId.get('s2')!.y).toBeLessThan(byId.get('s1')!.y);
    expect(byId.get('s3')!.y).toBeLessThan(byId.get('s2')!.y);
  });

  it('big fans stagger into the two-row vase; labels ride rowY, roots stay put', () => {
    const kids = ['a', 'b', 'c', 'd', 'e'];
    const nodes = [node('r', null), ...kids.map((id) => node(id, 'r'))];
    const { byId } = lay(nodes);
    // With >= 4 siblings the vase lifts alternating children: at least two
    // distinct rowY bands exist among the fan.
    const rows = new Set(kids.map((id) => byId.get(id)!.rowY));
    expect(rows.size).toBeGreaterThan(1);
    // rowY is the label anchor line: y minus its deterministic jitter —
    // always defined, never further than the jitter budget from y.
    for (const p of [...kids, 'r'].map((id) => byId.get(id)!)) {
      expect(p.rowY).toBeDefined();
      expect(Math.abs(p.y - p.rowY!)).toBeLessThan(20);
    }
  });
});
