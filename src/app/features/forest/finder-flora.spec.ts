import { describe, expect, it } from 'vitest';
import { Tree, TreeNode } from '../../core/db/schema';
import { findMatches, foldText } from './finder';
import { flowerFor } from './flora';

function tree(id: string, name: string): Tree {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    deletedAt: null,
    name,
    accent: 'moss',
    order: 10,
    currentNodeId: null,
    heartId: null,
    archivedAt: null,
  };
}
function node(id: string, treeId: string, title: string, archivedAt: number | null = null): TreeNode {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
    rev: 1,
    deletedAt: null,
    treeId,
    parentId: null,
    title,
    note: '',
    status: 'growing',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt,
    trigger: null,
  };
}

describe('finder', () => {
  it('folds accents and case — «Práctica» matches "practica"', () => {
    expect(foldText('PRÁCTICA')).toBe('practica');
    expect(foldText('Canción')).toBe('cancion');
  });

  it('needs two characters, matches tree names (nodeId null) and branch titles', () => {
    const t = tree('t1', 'Aprender guitarra');
    const n = node('n1', 't1', 'Práctica diaria');
    const hits = findMatches('practica', [t], () => [n]);
    expect(hits).toHaveLength(1);
    expect(hits[0].nodeId).toBe('n1');
    expect(findMatches('p', [t], () => [n])).toHaveLength(0);
    const treeHit = findMatches('guitarra', [t], () => [n]);
    expect(treeHit[0].nodeId).toBeNull();
  });

  it('a matched tree does not re-emit its heart (0.0.112 — one door, not two)', () => {
    const t = tree('t1', 'trabajo');
    const heart = node('h1', 't1', 'trabajo');
    const extra = node('n2', 't1', 'trabajo extra');
    const hits = findMatches('trabajo', [t], () => [heart, extra]);
    expect(hits.map((h) => h.nodeId)).toEqual([null, 'n2']); // tree door + real branch, no twin
  });

  it('skips archived branches and caps the list at 12', () => {
    const t = tree('t1', 'Bosque');
    const nodes = Array.from({ length: 20 }, (_, i) => node(`n${i}`, 't1', `rama ${i}`, i === 0 ? 99 : null));
    const hits = findMatches('rama', [t], () => nodes);
    expect(hits.map((h) => h.nodeId)).not.toContain('n0');
    expect(hits.length).toBeLessThanOrEqual(12);
  });
});

describe('flora', () => {
  it('a whole tree blooms ONE way — same seed, same cousin, forever', () => {
    const a = flowerFor('sage', 'tree-abc');
    const b = flowerFor('sage', 'tree-abc');
    expect(a.shape).toBe(b.shape);
  });

  it('omitting the seed returns the classic cousin', () => {
    expect(flowerFor('sky').shape).toBe('petal5');
    expect(flowerFor('sage').shape).toBe('bell');
  });

  it('every accent offers exactly three cousins reachable by seed', () => {
    const shapes = new Set<string>();
    for (let i = 0; i < 200; i++) shapes.add(flowerFor('pine', `seed-${i}`).shape);
    expect(shapes.size).toBe(3);
  });
});
