import { CheckIn, Tree, TreeNode } from '../../core/db/schema';
import { cadenceOf, frozenBeforeCadence, isScheduledOn, nextScheduledAfter } from '../../core/cadence';
import { ritualKind } from '../../core/harvest';
import { dayOf, isPast } from '../../core/time';

/**
 * «El almanaque» — the PURE time lens (0.0.81). Sister of suggest.ts and
 * tree-labels.ts: no Angular, fully vitest-able. It never schedules and it
 * never ranks — it only arranges what already happened (flowers, knots,
 * footprints) and what wants to come (capullos) onto days.
 *
 * The golden rule, as the owner decided it: the past shows what OCCURRED
 * (a flower on its achievedAt day, a golden knot on its branchedAt day),
 * and a passed-unresolved fecha amable stays visible on ITS day as a
 * capullo wearing a soft 🍂 — never red, never "atrasado", always a door
 * to the same dignified conversation.
 *
 * Senderos (repeatsDaily step paths) leave NO month marks: their morning
 * sweep erases yesterday's blooms by design, so painting them would show
 * history that vanishes overnight — the opposite of predictability. They
 * live only in «el caminito de hoy».
 */

/** One cell of the month grid. */
export interface AlmanacCell {
  /** 'YYYY-MM-DD' local date key. */
  date: string;
  /** False for the leading/trailing days that pad the first/last week. */
  inMonth: boolean;
}

/** A dated branch (capullo) waiting on a day. */
export interface DatedBranch {
  node: TreeNode;
  tree: Tree;
  /** The fecha amable already passed unresolved — wears the soft 🍂. */
  passed: boolean;
}

export interface BloomMark {
  node: TreeNode;
  tree: Tree;
}

/** Everything a single day holds. */
export interface DayMarks {
  capullos: DatedBranch[];
  flowers: BloomMark[];
  knots: BloomMark[];
  hasCheckin: boolean;
}

/** One cell mark, ready to render as glyph (narrow) or titled chip (wide).
 *  ONE priority order for both modes — they can never disagree. */
export interface DayChip {
  kind: 'flower' | 'knot' | 'capullo';
  node: TreeNode;
  tree: Tree;
  passed: boolean;
}

/** The cell's marks in render order (flowers > knots > capullos), capped.
 *  The cap is DISCIPLINE, not ranking: overflow folds into the quiet (N)
 *  and the day panel is the only full reader. */
export function dayChips(m: DayMarks, cap = 3): DayChip[] {
  const chips: DayChip[] = [
    ...m.flowers.map((f) => ({ kind: 'flower' as const, node: f.node, tree: f.tree, passed: false })),
    ...m.knots.map((k) => ({ kind: 'knot' as const, node: k.node, tree: k.tree, passed: false })),
    ...m.capullos.map((c) => ({ kind: 'capullo' as const, node: c.node, tree: c.tree, passed: c.passed })),
  ];
  return chips.slice(0, cap);
}

/** «Lo que se acerca» — a coming fecha amable, in soft words. */
export interface UpcomingDate {
  node: TreeNode;
  tree: Tree;
  when: 'tomorrow' | 'days' | 'week' | 'later';
}

/** One sendero rendered as today's stone path. */
export interface Caminito {
  parent: TreeNode;
  tree: Tree;
  steps: TreeNode[];
  /** The first unbloomed stone — the TEACCH «siguiente». Null = all bloomed. */
  nextId: string | null;
}

/** A loose stone (0.0.103): a single-act ritual leaf, walkable today. */
export interface Piedrita {
  node: TreeNode;
  tree: Tree;
  bloomed: boolean;
}

/** A ritual off its day — rests today, returns on `nextDay`. */
export interface RestingRitual {
  node: TreeNode;
  tree: Tree;
  nextDay: string;
}

/** Month grid as full weeks (rows of 7), padded with out-of-month cells.
 *  `month` is 1-based. `weekStart` 1 = Monday (es), 0 = Sunday (en). */
export function monthMatrix(year: number, month: number, weekStart: 0 | 1 = 1): AlmanacCell[][] {
  const key = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const lead = (firstWeekday - weekStart + 7) % 7;

  const cells: AlmanacCell[] = [];
  // Leading pad from the previous month.
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevDays = new Date(prevYear, prevMonth, 0).getDate();
  for (let i = lead - 1; i >= 0; i--) {
    cells.push({ date: key(prevYear, prevMonth, prevDays - i), inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: key(year, month, d), inMonth: true });
  }
  // Trailing pad to complete the last week.
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let d = 1; cells.length % 7 !== 0; d++) {
    cells.push({ date: key(nextYear, nextMonth, d), inMonth: false });
  }

  const weeks: AlmanacCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Ids of every ritual STEP and every ritual LEAF — excluded from ALL month
 *  marks (see header): their achievedAt is erased by the sweep, and painting
 *  vanishing history breaks predictability. Recursive for paths: a step's
 *  own sub-steps vanish with it. A BRANCHED former ritual stops excluding —
 *  its branch-born alternatives are ordinary branches and deserve marks. */
export function senderoStepIds(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
): Set<string> {
  const ids = new Set<string>();
  for (const tree of trees) {
    const nodes = nodesByTree.get(tree.id) ?? [];
    const childrenOf = new Map<string, TreeNode[]>();
    for (const n of nodes) {
      if (!n.parentId) continue;
      childrenOf.set(n.parentId, [...(childrenOf.get(n.parentId) ?? []), n]);
    }
    const sweep = (parentId: string, root: TreeNode) => {
      for (const child of childrenOf.get(parentId) ?? []) {
        if (ids.has(child.id)) continue;
        // «La historia se queda» (0.0.106): a bloom frozen before the
        // cadence KEEPS its month mark — the ritual sweep never erases it,
        // so painting it is stable history, not vanishing history. Its
        // subtree belongs to the same old story.
        if (child.status === 'achieved' && child.achievedAt && frozenBeforeCadence(child.achievedAt, root)) continue;
        ids.add(child.id);
        sweep(child.id, root);
      }
    };
    for (const node of nodes) {
      // ONE law with the fruit-minting guard (core/harvest.ts bearsNoFruit)
      // — the month grid and the jar must never disagree about rituals.
      const kind = ritualKind(node);
      if (kind === 'path') sweep(node.id, node);
      else if (kind === 'leaf') ids.add(node.id);
    }
  }
  return ids;
}

/** Every day's marks, keyed 'YYYY-MM-DD'. Feed it live data only
 *  (`trees.active()` + each tree's visible nodes — the two-layer law). */
export function marksFor(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  checkins: CheckIn[],
  today: string,
): Map<string, DayMarks> {
  const marks = new Map<string, DayMarks>();
  const at = (date: string): DayMarks => {
    let m = marks.get(date);
    if (!m) {
      m = { capullos: [], flowers: [], knots: [], hasCheckin: false };
      marks.set(date, m);
    }
    return m;
  };
  const excluded = senderoStepIds(trees, nodesByTree);

  for (const tree of trees) {
    for (const node of nodesByTree.get(tree.id) ?? []) {
      if (excluded.has(node.id)) continue;
      // Capullos: live branches with a fecha amable, on that date — passed
      // ones stay on THEIR day (owner rule: predictability over hiding).
      if (
        node.targetDate !== null &&
        (node.status === 'seed' || node.status === 'growing' || node.status === 'resting')
      ) {
        at(node.targetDate).capullos.push({ node, tree, passed: node.targetDate < today });
      }
      // Flowers: the day a bloom actually opened — only while the bloom
      // STANDS (reopening a branch takes its flower with it; a branched
      // node's day shows the knot, its transformation, not the old bloom).
      if (node.achievedAt && node.status === 'achieved') {
        at(dayOf(node.achievedAt)).flowers.push({ node, tree });
      }
      // Golden knots: the day a branch transformed into new paths.
      if (node.branchedAt && node.status === 'branched') {
        at(dayOf(node.branchedAt)).knots.push({ node, tree });
      }
    }
  }

  for (const checkin of checkins) {
    at(dayOf(checkin.createdAt)).hasCheckin = true;
  }

  return marks;
}

/** The next few fechas amables, in soft words — never a countdown. */
export function upcoming(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  today: string,
  cap = 3,
): UpcomingDate[] {
  const out: { entry: UpcomingDate; date: string }[] = [];
  const excluded = senderoStepIds(trees, nodesByTree);
  for (const tree of trees) {
    for (const node of nodesByTree.get(tree.id) ?? []) {
      if (excluded.has(node.id)) continue;
      if (node.targetDate === null || node.targetDate <= today) continue;
      if (node.status !== 'seed' && node.status !== 'growing' && node.status !== 'resting') continue;
      out.push({ entry: { node, tree, when: whenWord(today, node.targetDate) }, date: node.targetDate });
    }
  }
  return out
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.entry.node.id < b.entry.node.id ? -1 : 1))
    .slice(0, cap)
    .map((o) => o.entry);
}

/** Branches whose fecha amable is exactly TODAY — the Hoy section's own
 *  list (they are in nobody else's: the 🍂 talk is strictly-past and
 *  «lo que se acerca» is strictly-future). */
export function todayDated(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  today: string,
): DatedBranch[] {
  const out: DatedBranch[] = [];
  const excluded = senderoStepIds(trees, nodesByTree);
  for (const tree of trees) {
    for (const node of nodesByTree.get(tree.id) ?? []) {
      if (excluded.has(node.id)) continue;
      if (node.targetDate !== today) continue;
      if (node.status !== 'seed' && node.status !== 'growing' && node.status !== 'resting') continue;
      out.push({ node, tree, passed: false });
    }
  }
  return out.sort((a, b) => (a.node.id < b.node.id ? -1 : 1));
}

/** Word distance for a FUTURE date: mañana / en unos días / la próxima
 *  semana / más adelante. Words, never numbers — counters escalate. */
export function whenWord(today: string, date: string): UpcomingDate['when'] {
  const [y, m, d] = date.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d, 12) - Date.UTC(ty, tm - 1, td, 12)) / 86_400_000);
  if (days <= 1) return 'tomorrow';
  if (days <= 6) return 'days';
  if (days <= 13) return 'week';
  return 'later';
}

/** Today's stone paths: every live ritual PATH scheduled today, steps in
 *  walking order. */
export function caminitos(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  today: string,
): Caminito[] {
  const out: Caminito[] = [];
  for (const tree of trees) {
    const nodes = nodesByTree.get(tree.id) ?? [];
    for (const parent of nodes) {
      // Only LIVE ritual paths walk today: resting pauses the path (and the
      // sweep — see rituals.service), achieved retires it, branched
      // dissolved it. Weekday paths off their day rest (descansanHoy).
      const cadence = cadenceOf(parent);
      if (!cadence || parent.flow !== 'steps') continue;
      if (!(parent.status === 'seed' || parent.status === 'growing')) continue;
      if (!isScheduledOn(cadence, today)) continue;
      const steps = nodes
        .filter((n) => n.parentId === parent.id && ritualKind(n) !== 'leaf')
        // Frozen pre-cadence blooms are history, not today's walk — a stone
        // that reads «done» every morning forever would be a daily lie.
        .filter((n) => !(n.status === 'achieved' && n.achievedAt && frozenBeforeCadence(n.achievedAt, parent)))
        .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
      if (!steps.length) continue;
      const next = steps.find((s) => s.status === 'seed' || s.status === 'growing');
      out.push({ parent, tree, steps, nextId: next?.id ?? null });
    }
  }
  return out;
}

/** Today's loose stones: every live ritual LEAF scheduled today — pending
 *  or bloomed-today (live status IS «done this period»; the sweep is the
 *  one clock). */
export function piedritas(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  today: string,
): Piedrita[] {
  const out: Piedrita[] = [];
  for (const tree of trees) {
    for (const node of nodesByTree.get(tree.id) ?? []) {
      if (ritualKind(node) !== 'leaf') continue;
      if (node.status === 'resting') continue; // descansando pauses the loop
      const cadence = cadenceOf(node)!;
      if (!isScheduledOn(cadence, today)) continue;
      out.push({ node, tree, bloomed: node.status === 'achieved' });
    }
  }
  return out.sort((a, b) => a.node.order - b.node.order || (a.node.id < b.node.id ? -1 : 1));
}

/** Rituals (paths + leaves) NOT scheduled today — the gentle rest line
 *  («vuelve el jueves»), never a countdown. */
export function descansanHoy(
  trees: Tree[],
  nodesByTree: Map<string, TreeNode[]>,
  today: string,
): RestingRitual[] {
  const out: RestingRitual[] = [];
  for (const tree of trees) {
    for (const node of nodesByTree.get(tree.id) ?? []) {
      const kind = ritualKind(node);
      if (!kind) continue;
      const restingEligible =
        node.status === 'seed' || node.status === 'growing' || (kind === 'leaf' && node.status === 'achieved');
      if (!restingEligible) continue;
      const cadence = cadenceOf(node)!;
      if (isScheduledOn(cadence, today)) continue;
      const next = nextScheduledAfter(cadence, today);
      if (next) out.push({ node, tree, nextDay: next });
    }
  }
  return out.sort((a, b) => (a.nextDay < b.nextDay ? -1 : 1));
}
