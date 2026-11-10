import { describe, expect, it } from 'vitest';
import { Harvest, Preserve, TreeNode } from './db/schema';
import {
  bearsNoFruit,
  deriveAccent,
  harvestMonths,
  isDailyPathParent,
  isElixir,
  isFresh,
  isPending,
  isPromise,
  isSealedJam,
  jarCapacity,
  jarSizeFor,
  membersOf,
  occurrenceRitual,
  ritualKind,
  underDailyPath,
} from './harvest';

function node(id: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
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
    ...extra,
  };
}

function harvest(id: string, harvestedAt: number): Harvest {
  return {
    id: 'h:' + id,
    createdAt: harvestedAt,
    updatedAt: harvestedAt,
    rev: 1,
    deletedAt: null,
    nodeId: id,
    treeId: 't1',
    treeName: 'Árbol',
    accent: 'moss',
    title: id,
    harvestedAt,
  };
}

/** Local epoch-ms noon for a date key — mirrors dayOf's local math. */
function noonOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const byId = (nodes: TreeNode[]) => new Map(nodes.map((n) => [n.id, n]));

describe('isDailyPathParent — THE sendero law, single home', () => {
  it('holds only for live repeatsDaily steps parents', () => {
    expect(isDailyPathParent(node('s', { repeatsDaily: true, flow: 'steps' }))).toBe(true);
    expect(isDailyPathParent(node('s', { repeatsDaily: true, flow: 'steps', status: 'resting' }))).toBe(true);
    expect(isDailyPathParent(node('s', { flow: 'steps' }))).toBe(false);
    expect(isDailyPathParent(node('s', { repeatsDaily: true }))).toBe(false);
  });

  it('a BRANCHED former sendero stops qualifying (its alternatives are ordinary branches)', () => {
    expect(
      isDailyPathParent(node('s', { repeatsDaily: true, flow: 'steps', status: 'branched' })),
    ).toBe(false);
  });
});

describe('underDailyPath — pasitos (and sub-pasitos) bear no fruit', () => {
  const sendero = node('camino', { repeatsDaily: true, flow: 'steps' });
  const step = node('paso', { parentId: 'camino' });
  const subStep = node('sub', { parentId: 'paso' });

  it('finds the sendero at any ancestor depth', () => {
    const map = byId([sendero, step, subStep]);
    expect(underDailyPath(step, map)).toBe(true);
    expect(underDailyPath(subStep, map)).toBe(true);
  });

  it('the sendero parent itself is NOT under a daily path (retiring it bears fruit)', () => {
    expect(underDailyPath(sendero, byId([sendero, step]))).toBe(false);
  });

  it('a spiral keeps its own rhythm inside a sendero', () => {
    const spiral = node('spiral', { parentId: sendero.id, repeats: ['thu'] });
    const map = byId([sendero, step, spiral]);
    expect(occurrenceRitual(spiral, map)).toBe(spiral);
    expect(occurrenceRitual(step, map)).toBe(sendero);
  });

  it('ordinary branches and children of a BRANCHED former sendero walk free', () => {
    const branched = node('bp', { repeatsDaily: true, flow: 'steps', status: 'branched' });
    const alt = node('alt', { parentId: 'bp' });
    expect(underDailyPath(node('root'), byId([]))).toBe(false);
    expect(underDailyPath(alt, byId([branched, alt]))).toBe(false);
  });

  it('a missing parent or a parent cycle never hangs and never lies', () => {
    const orphan = node('o', { parentId: 'gone' });
    expect(underDailyPath(orphan, byId([orphan]))).toBe(false);
    const a = node('a', { parentId: 'b' });
    const b = node('b', { parentId: 'a' });
    expect(underDailyPath(a, byId([a, b]))).toBe(false);
  });
});

describe('bearsNoFruit — the generalized ritual law (0.0.103)', () => {
  it('a ritual LEAF (any cadence) mints nothing while it carries its rhythm', () => {
    expect(bearsNoFruit(node('l', { repeats: 'daily' }), byId([]))).toBe(true);
    expect(bearsNoFruit(node('l', { repeats: 'weekly' }), byId([]))).toBe(true);
    expect(bearsNoFruit(node('l', { repeats: ['tue'] }), byId([]))).toBe(true);
  });

  it('retiring a leaf = clearing its cadence → its bloom mints again', () => {
    expect(bearsNoFruit(node('l', { repeats: null, repeatsDaily: true }), byId([]))).toBe(false);
    expect(bearsNoFruit(node('l', {}), byId([]))).toBe(false);
  });

  it('a ritual PATH parent is not a leaf — retiring the whole path mints', () => {
    const path = node('p', { repeats: 'daily', flow: 'steps' });
    expect(bearsNoFruit(path, byId([path]))).toBe(false);
  });

  it('pasitos of weekday/weekly ritual paths bear no fruit (legacy law extends)', () => {
    const path = node('p', { repeats: ['mon'], flow: 'steps' });
    const step = node('s', { parentId: 'p' });
    expect(bearsNoFruit(step, byId([path, step]))).toBe(true);
  });

  it('accidental children of a ritual LEAF are ordinary one-time branches', () => {
    const leaf = node('l', { repeats: 'daily' });
    const child = node('c', { parentId: 'l' });
    expect(bearsNoFruit(child, byId([leaf, child]))).toBe(false);
  });

  it('ritualKind: legacy repeatsDaily still classifies as a path', () => {
    expect(ritualKind(node('s', { repeatsDaily: true, flow: 'steps' }))).toBe('path');
    expect(ritualKind(node('l', { repeatsDaily: true }))).toBe('leaf');
    expect(ritualKind(node('n', {}))).toBeNull();
  });
});

describe('la conservería — single-home + flavor derivation', () => {
  it('isFresh: absent and null both mean the harvest jar', () => {
    expect(isFresh(harvest('a', 1))).toBe(true);
    expect(isFresh({ ...harvest('b', 1), preserveId: null })).toBe(true);
    expect(isFresh({ ...harvest('c', 1), preserveId: 'p1' })).toBe(false);
  });

  it('membersOf finds a jar’s fruits newest-first', () => {
    const rows = [
      { ...harvest('x', 10), preserveId: 'p1' },
      { ...harvest('y', 30), preserveId: 'p1' },
      { ...harvest('z', 20), preserveId: 'p2' },
      harvest('w', 40),
    ];
    expect(membersOf('p1', rows).map((h) => h.nodeId)).toEqual(['y', 'x']);
  });

  it('deriveAccent: one species → its accent; mixed → null (del bosque, first-class)', () => {
    const apple = { ...harvest('a', 1) };
    const pear = { ...harvest('b', 1), accent: 'sage' as const };
    expect(deriveAccent([apple, { ...harvest('c', 2) }])).toBe('moss');
    expect(deriveAccent([apple, pear])).toBeNull();
  });

  it('jarSizeFor — THE vessel threshold law: 1–2/3–5/6+', () => {
    expect(jarSizeFor(1)).toBe('frasquito');
    expect(jarSizeFor(2)).toBe('frasquito');
    expect(jarSizeFor(3)).toBe('frasco');
    expect(jarSizeFor(5)).toBe('frasco');
    expect(jarSizeFor(6)).toBe('frascote');
    expect(jarSizeFor(20)).toBe('frascote');
  });
});

describe('la promesa — goal jars (0.0.93)', () => {
  function preserve(extra: Partial<Preserve> = {}): Preserve {
    return {
      id: 'p1',
      createdAt: 0,
      updatedAt: 0,
      rev: 1,
      deletedAt: null,
      kind: 'mermelada',
      name: 'Mi frasco',
      madeAt: 0,
      accent: null,
      tint: '#000',
      tintEdge: '#000',
      ...extra,
    };
  }

  it('jarCapacity — the TOP of each published band; a full jar re-derives its own size', () => {
    expect(jarCapacity('frasquito')).toBe(2);
    expect(jarCapacity('frasco')).toBe(5);
    expect(jarCapacity('frascote')).toBe(8);
    // The consistency invariant: a filled goal jar looks like a pot jam.
    expect(jarSizeFor(jarCapacity('frasquito'))).toBe('frasquito');
    expect(jarSizeFor(jarCapacity('frasco'))).toBe('frasco');
    expect(jarSizeFor(jarCapacity('frascote'))).toBe('frascote');
  });

  it('isPromise: only a jar born at the wizard (plannedAt set)', () => {
    expect(isPromise(preserve())).toBe(false); // legacy pot jam
    expect(isPromise(preserve({ plannedAt: 100 }))).toBe(true);
    expect(isPromise(preserve({ plannedAt: null }))).toBe(false);
  });

  it('isPending / isSealedJam across the three jar shapes', () => {
    const potJam = preserve(); // plannedAt & sealedAt absent
    const pendingPromise = preserve({ plannedAt: 100, sealedAt: null });
    const sealedPromise = preserve({ plannedAt: 100, sealedAt: 200 });

    expect(isPending(potJam)).toBe(false);
    expect(isPending(pendingPromise)).toBe(true);
    expect(isPending(sealedPromise)).toBe(false);

    // The alacena keeps everything that is NOT a pending goal jar.
    expect(isSealedJam(potJam)).toBe(true);
    expect(isSealedJam(pendingPromise)).toBe(false);
    expect(isSealedJam(sealedPromise)).toBe(true);
  });

  it('isElixir: only kind==="elixir" (jams stay on their own shelves)', () => {
    expect(isElixir(preserve())).toBe(false);
    expect(isElixir(preserve({ kind: 'elixir', treeId: 't1', carry: 'constancia' }))).toBe(true);
    // an elixir would look like a sealed jam by plannedAt/sealedAt — shelves
    // must exclude it explicitly (that guard is in PreservesRepo/cosecha).
    expect(isSealedJam(preserve({ kind: 'elixir' }))).toBe(true);
  });
});

describe('harvestMonths — shelves, never comparisons', () => {
  it('groups by local month, freshest month first, newest fruit first within', () => {
    const rows = [
      harvest('june-early', noonOf('2026-06-03')),
      harvest('july-late', noonOf('2026-07-20')),
      harvest('july-early', noonOf('2026-07-02')),
      harvest('june-late', noonOf('2026-06-28')),
    ];
    const months = harvestMonths(rows);
    expect(months.map((m) => m.key)).toEqual(['2026-07', '2026-06']);
    expect(months[0].items.map((h) => h.nodeId)).toEqual(['july-late', 'july-early']);
    expect(months[1].items.map((h) => h.nodeId)).toEqual(['june-late', 'june-early']);
  });

  it('is empty on an empty pantry and stable on same-instant ties', () => {
    expect(harvestMonths([])).toEqual([]);
    const t = noonOf('2026-07-10');
    const months = harvestMonths([harvest('b', t), harvest('a', t)]);
    expect(months[0].items.map((h) => h.nodeId)).toEqual(['a', 'b']);
  });
});
