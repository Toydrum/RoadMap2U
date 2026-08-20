import { describe, expect, it } from 'vitest';
import { CheckIn, Tree, TreeNode } from '../../core/db/schema';
import { caminitos, dayChips, marksFor, monthMatrix, senderoStepIds, todayDated, upcoming, whenWord } from './almanac';

function tree(id: string, name = id): Tree {
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

function node(id: string, treeId: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
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
    ...extra,
  };
}

function checkin(id: string, createdAt: number): CheckIn {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    rev: 1,
    deletedAt: null,
    feeling: 'calm',
    note: '',
    treeId: null,
    nodeId: null,
  };
}

/** Local epoch-ms noon for a date key — mirrors dayOf's local math. */
function noonOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

const byTree = (trees: Tree[], nodes: TreeNode[]) => {
  const map = new Map<string, TreeNode[]>();
  for (const t of trees) map.set(t.id, nodes.filter((n) => n.treeId === t.id));
  return map;
};

const TODAY = '2026-07-15';

describe('monthMatrix', () => {
  it('pads to full weeks, Monday-first — July 2026 starts on a Wednesday', () => {
    const weeks = monthMatrix(2026, 7, 1);
    expect(weeks[0]).toHaveLength(7);
    // 2026-07-01 is a Wednesday: two leading June days (Mon 29, Tue 30).
    expect(weeks[0][0]).toEqual({ date: '2026-06-29', inMonth: false });
    expect(weeks[0][2]).toEqual({ date: '2026-07-01', inMonth: true });
    const flat = weeks.flat();
    expect(flat.filter((c) => c.inMonth)).toHaveLength(31);
    expect(flat.length % 7).toBe(0);
  });

  it('handles February and the year wrap', () => {
    const feb = monthMatrix(2027, 2, 1).flat().filter((c) => c.inMonth);
    expect(feb).toHaveLength(28);
    const dec = monthMatrix(2026, 12, 1).flat();
    expect(dec.some((c) => c.date.startsWith('2027-01') && !c.inMonth)).toBe(true);
    const jan = monthMatrix(2026, 1, 1).flat();
    expect(jan.some((c) => c.date.startsWith('2025-12') && !c.inMonth)).toBe(true);
  });

  it('Sunday-first shifts the lead', () => {
    const weeks = monthMatrix(2026, 7, 0);
    // Sunday-first: July 1 (Wednesday) sits at index 3.
    expect(weeks[0][3]).toEqual({ date: '2026-07-01', inMonth: true });
  });
});

describe('marksFor — the golden rule', () => {
  it('future capullo on its day; passed-unresolved stays on ITS day wearing passed=true', () => {
    const t = tree('t1');
    const nodes = [
      node('future', 't1', { targetDate: '2026-07-20' }),
      node('missed', 't1', { targetDate: '2026-07-10' }),
    ];
    const marks = marksFor([t], byTree([t], nodes), [], TODAY);
    expect(marks.get('2026-07-20')!.capullos[0]).toMatchObject({ passed: false });
    expect(marks.get('2026-07-10')!.capullos[0]).toMatchObject({ passed: true });
  });

  it('flowers on the achievedAt day, knots on the branchedAt day', () => {
    const t = tree('t1');
    const nodes = [
      node('bloomed', 't1', { status: 'achieved', achievedAt: noonOf('2026-07-03') }),
      node('knotted', 't1', { status: 'branched', branchedAt: noonOf('2026-07-08') }),
    ];
    const marks = marksFor([t], byTree([t], nodes), [], TODAY);
    expect(marks.get('2026-07-03')!.flowers).toHaveLength(1);
    expect(marks.get('2026-07-08')!.knots).toHaveLength(1);
    // achieved/branched never render a capullo even if a date lingers
    expect(marks.get('2026-07-03')!.capullos).toHaveLength(0);
  });

  it('sendero steps leave NO month marks (their history vanishes by design)', () => {
    const t = tree('t1');
    const parent = node('camino', 't1', { flow: 'steps', repeatsDaily: true });
    const step = node('paso', 't1', {
      parentId: 'camino',
      status: 'achieved',
      achievedAt: noonOf('2026-07-14'),
      targetDate: '2026-07-20',
    });
    const marks = marksFor([t], byTree([t], [parent, step]), [], TODAY);
    expect(marks.get('2026-07-14')?.flowers ?? []).toHaveLength(0);
    expect(marks.get('2026-07-20')?.capullos ?? []).toHaveLength(0);
  });

  it('a reopened bloom takes its flower with it (0.0.82: status-gated)', () => {
    const t = tree('t1');
    const reopened = node('r1', 't1', { status: 'growing', achievedAt: noonOf('2026-07-03') });
    const marks = marksFor([t], byTree([t], [reopened]), [], TODAY);
    expect(marks.get('2026-07-03')?.flowers ?? []).toHaveLength(0);
    // and a branched node shows ONLY its knot, never the old bloom
    const knotted = node('k1', 't1', {
      status: 'branched',
      achievedAt: noonOf('2026-07-02'),
      branchedAt: noonOf('2026-07-08'),
    });
    const marks2 = marksFor([t], byTree([t], [knotted]), [], TODAY);
    expect(marks2.get('2026-07-02')?.flowers ?? []).toHaveLength(0);
    expect(marks2.get('2026-07-08')!.knots).toHaveLength(1);
  });

  it('a BRANCHED former sendero stops hiding its children; sub-steps stay hidden recursively', () => {
    const t = tree('t1');
    const branchedParent = node('bp', 't1', { flow: 'steps', repeatsDaily: true, status: 'branched' });
    const alt = node('alt', 't1', { parentId: 'bp' });
    const liveParent = node('lp', 't1', { flow: 'steps', repeatsDaily: true });
    const step = node('st', 't1', { parentId: 'lp' });
    const subStep = node('sub', 't1', { parentId: 'st' });
    const ids = senderoStepIds([t], byTree([t], [branchedParent, alt, liveParent, step, subStep]));
    expect(ids.has('alt')).toBe(false);
    expect(ids.has('st')).toBe(true);
    expect(ids.has('sub')).toBe(true);
  });

  it('check-ins mark presence only', () => {
    const t = tree('t1');
    const marks = marksFor([t], byTree([t], []), [checkin('c1', noonOf('2026-07-05'))], TODAY);
    expect(marks.get('2026-07-05')!.hasCheckin).toBe(true);
    expect(marks.get('2026-07-05')!.flowers).toHaveLength(0);
  });

  it('a ritual LEAF leaves NO month marks (0.0.103 — vanishing history is never painted)', () => {
    const t = tree('t1');
    const leaf = node('leaf', 't1', { repeats: 'daily', status: 'achieved', achievedAt: noonOf('2026-07-05') });
    const ids = senderoStepIds([t], byTree([t], [leaf]));
    expect(ids.has('leaf')).toBe(true);
    const marks = marksFor([t], byTree([t], [leaf]), [], TODAY);
    expect(marks.get('2026-07-05')?.flowers ?? []).toHaveLength(0);
    // retiring it (cadence cleared) frees its marks again — ordinary branch
    const retired = { ...leaf, repeats: null, repeatsDaily: false };
    const marks2 = marksFor([t], byTree([t], [retired]), [], TODAY);
    expect(marks2.get('2026-07-05')!.flowers).toHaveLength(1);
  });

  it('«la historia se queda» (0.0.106): a bloom frozen before the cadence KEEPS its month mark', () => {
    const t = tree('t1');
    // Converted to a ritual on TODAY; s1 bloomed long before — frozen history.
    const parent = node('camino', 't1', { flow: 'steps', repeats: 'daily', repeatsSetAt: noonOf(TODAY) });
    const s1 = node('s1', 't1', { parentId: 'camino', status: 'achieved', achievedAt: noonOf('2026-07-03') });
    const sub = node('sub', 't1', { parentId: 's1', status: 'achieved', achievedAt: noonOf('2026-07-02') });
    const s2 = node('s2', 't1', { parentId: 'camino', status: 'seed' });
    const ids = senderoStepIds([t], byTree([t], [parent, s1, sub, s2]));
    expect(ids.has('s1')).toBe(false); // frozen — keeps its mark
    expect(ids.has('sub')).toBe(false); // its subtree is the same old story
    expect(ids.has('s2')).toBe(true); // the ritual's own walk stays markless
    const marks = marksFor([t], byTree([t], [parent, s1, sub, s2]), [], TODAY);
    expect(marks.get('2026-07-03')!.flowers).toHaveLength(1);
    // Legacy ritual (no stamp): nothing frozen — pre-v11 behavior intact.
    const legacy = node('camino', 't1', { flow: 'steps', repeatsDaily: true });
    const legacyIds = senderoStepIds([t], byTree([t], [legacy, s1, s2]));
    expect(legacyIds.has('s1')).toBe(true);
  });
});

describe('upcoming — soft words, never numbers', () => {
  it('caps at 3, soonest first, and words the distance', () => {
    const t = tree('t1');
    const nodes = [
      node('a', 't1', { targetDate: '2026-07-16' }),
      node('b', 't1', { targetDate: '2026-07-18' }),
      node('c', 't1', { targetDate: '2026-07-24' }),
      node('d', 't1', { targetDate: '2026-08-30' }),
    ];
    const list = upcoming([t], byTree([t], nodes), TODAY);
    expect(list.map((u) => u.node.id)).toEqual(['a', 'b', 'c']);
    expect(list.map((u) => u.when)).toEqual(['tomorrow', 'days', 'week']);
  });

  it('today and the past never appear (they live in the grid + the 🍂 talk)', () => {
    const t = tree('t1');
    const nodes = [
      node('today', 't1', { targetDate: TODAY }),
      node('past', 't1', { targetDate: '2026-07-01' }),
    ];
    expect(upcoming([t], byTree([t], nodes), TODAY)).toHaveLength(0);
  });

  it('whenWord maps the far future to «later»', () => {
    expect(whenWord(TODAY, '2026-08-30')).toBe('later');
  });
});

describe('dayChips — one priority for both renderings', () => {
  it('orders flowers > knots > capullos, caps, and carries passed', () => {
    const t = tree('t1');
    const m = marksFor(
      [t],
      byTree([t], [
        node('c1', 't1', { targetDate: '2026-07-10' }),
        node('c2', 't1', { targetDate: '2026-07-10' }),
        node('f1', 't1', { status: 'achieved', achievedAt: noonOf('2026-07-10') }),
        node('k1', 't1', { status: 'branched', branchedAt: noonOf('2026-07-10') }),
      ]),
      [],
      TODAY,
    ).get('2026-07-10')!;
    const chips = dayChips(m, 3);
    expect(chips.map((c) => c.kind)).toEqual(['flower', 'knot', 'capullo']);
    expect(chips[2].passed).toBe(true); // 2026-07-10 < TODAY
    expect(dayChips(m, 2)).toHaveLength(2);
  });
});

describe('todayDated', () => {
  it('lists ONLY branches dated exactly today (past → 🍂 talk, future → upcoming)', () => {
    const t = tree('t1');
    const nodes = [
      node('hoy', 't1', { targetDate: TODAY }),
      node('past', 't1', { targetDate: '2026-07-01' }),
      node('future', 't1', { targetDate: '2026-07-20' }),
    ];
    const rows = todayDated([t], byTree([t], nodes), TODAY);
    expect(rows.map((r) => r.node.id)).toEqual(['hoy']);
  });
});

describe('caminitos', () => {
  it('a RESTING sendero pauses — it leaves today\'s path until it wakes', () => {
    const t = tree('t1');
    const parent = node('camino', 't1', { flow: 'steps', repeatsDaily: true, status: 'resting' });
    const s1 = node('s1', 't1', { parentId: 'camino' });
    expect(caminitos([t], byTree([t], [parent, s1]), TODAY)).toHaveLength(0);
  });

  it('frozen pre-cadence blooms are history, not stones — the walk shows only what came after', () => {
    const t = tree('t1');
    const parent = node('camino', 't1', { flow: 'steps', repeats: 'daily', repeatsSetAt: noonOf(TODAY) });
    const frozen = node('f1', 't1', { parentId: 'camino', order: 10, status: 'achieved', achievedAt: noonOf('2026-07-03') });
    const open = node('o1', 't1', { parentId: 'camino', order: 20, status: 'seed' });
    const [c] = caminitos([t], byTree([t], [parent, frozen, open]), TODAY);
    expect(c.steps.map((s) => s.id)).toEqual(['o1']);
    expect(c.nextId).toBe('o1');
  });

  it('orders steps by walking order and points «siguiente» at the first open stone', () => {
    const t = tree('t1');
    const parent = node('camino', 't1', { flow: 'steps', repeatsDaily: true });
    const s1 = node('s1', 't1', { parentId: 'camino', order: 10, status: 'achieved', achievedAt: 1 });
    const s2 = node('s2', 't1', { parentId: 'camino', order: 20 });
    const s3 = node('s3', 't1', { parentId: 'camino', order: 30, status: 'seed' });
    const [c] = caminitos([t], byTree([t], [parent, s1, s2, s3]), TODAY);
    expect(c.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(c.nextId).toBe('s2');
  });

  it('a plain steps parent (no repeatsDaily) is not a caminito; all-bloomed has no next', () => {
    const t = tree('t1');
    const plain = node('plain', 't1', { flow: 'steps' });
    const p1 = node('p1', 't1', { parentId: 'plain' });
    const done = node('done', 't1', { flow: 'steps', repeatsDaily: true });
    const d1 = node('d1', 't1', { parentId: 'done', status: 'achieved', achievedAt: 1 });
    const list = caminitos([t], byTree([t], [plain, p1, done, d1]), TODAY);
    expect(list).toHaveLength(1);
    expect(list[0].parent.id).toBe('done');
    expect(list[0].nextId).toBeNull();
  });
});
