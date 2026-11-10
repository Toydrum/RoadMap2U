import { AccentToken, Harvest, JarVessel, Preserve, TreeNode } from './db/schema';
import { cadenceOf } from './cadence';
import { dayOf } from './time';

/**
 * «La cosecha» — the PURE harvest brain (0.0.88). Sister of suggest.ts:
 * no Angular, fully vitest-able. It holds THE ritual law in one place
 * (the almanaque's exclusion and the fruit-minting guard must never
 * disagree) and arranges harvests into months for the pantry page.
 *
 * The law, doctrine-grade (0.0.72 senderos → 0.0.103 piedritas): every
 * achieved branch bears one fruit — except the recurring ones. Las
 * piedritas no dan fruta; el ritual entero, al retirarse, sí. (A durable
 * fruit minted per period by a routine is a day-counter wearing a costume;
 * the caminito is already their celebration.) A ritual LEAF retires by
 * CLEARING its cadence — its next/standing bloom then mints with honor.
 */

/** What kind of ritual a node is: 'path' = a steps parent with a cadence
 *  (its pasitos reset — the classic sendero); 'leaf' = a lone recurring
 *  branch (it resets ITSELF); null = not recurring. A BRANCHED former
 *  ritual stops qualifying: its branch-born alternatives are ordinary. */
export function ritualKind(node: TreeNode): 'path' | 'leaf' | null {
  if (!cadenceOf(node) || node.status === 'branched') return null;
  return node.flow === 'steps' ? 'path' : 'leaf';
}

/** Back-compat name used across verifies and older call sites. */
export function isDailyPathParent(node: TreeNode): boolean {
  return ritualKind(node) === 'path';
}

/** True when any ANCESTOR is a live ritual path — the node is a pasito
 *  (or a sub-pasito). The ritual parent itself is NOT under a path:
 *  retiring the whole ritual bears fruit with honor. */
export function underRitualPath(
  node: TreeNode,
  byId: ReadonlyMap<string, TreeNode>,
): boolean {
  return ritualPathOf(node, byId) !== null;
}

function ritualPathOf(node: TreeNode, byId: ReadonlyMap<string, TreeNode>): TreeNode | null {
  const seen = new Set<string>();
  let current: TreeNode | undefined = node;
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) return null;
    if (ritualKind(parent) === 'path') return parent;
    current = parent;
  }
  return null;
}

/** An occurrence is either a spiral or a step within a recurring path.
 *  The path itself can still be bloomed as a final milestone. */
export function occurrenceRitual(node: TreeNode, byId: ReadonlyMap<string, TreeNode>): TreeNode | null {
  return ritualKind(node) === 'leaf' ? node : ritualPathOf(node, byId);
}

/** Back-compat alias (pre-0.0.103 name). */
export const underDailyPath = underRitualPath;

/** THE consumer-facing law: a bloom on this node mints NO fruit — either
 *  it's a pasito of a ritual path, or it's a ritual leaf still carrying
 *  its cadence. One predicate, every consumer (fruit guard, month marks,
 *  fruit-drop) — the grid and the jar must never disagree. */
export function bearsNoFruit(
  node: TreeNode,
  byId: ReadonlyMap<string, TreeNode>,
): boolean {
  return ritualKind(node) === 'leaf' || underRitualPath(node, byId);
}

/** «La conservería» (0.0.89): fresh = still in the harvest jar. The
 *  single-home law — a fruit lives in exactly ONE place. */
export function isFresh(h: Harvest): boolean {
  return !h.preserveId;
}

/** A sealed jar's member fruits, newest first (the disclosure panel's
 *  order — same tiebreak as everywhere). */
export function membersOf(preserveId: string, rows: Harvest[]): Harvest[] {
  return rows
    .filter((h) => h.preserveId === preserveId)
    .sort((a, b) => b.harvestedAt - a.harvestedAt || (a.id < b.id ? -1 : 1));
}

/** The batch's flavor: one species → its accent; mixed → null =
 *  «mermelada del bosque» (first-class, never a fallback). */
export function deriveAccent(members: Harvest[]): AccentToken | null {
  const accents = new Set(members.map((m) => m.accent));
  return accents.size === 1 ? members[0].accent : null;
}

/** THE one vessel-threshold law (0.0.90 — «el frasco sirve a la fruta»):
 *  1–2 frutas → frasquito · 3–5 → frasco · 6+ → frascote. Published in the
 *  guide, NEVER computed forward on a working surface (no pot counters). */
export function jarSizeFor(count: number): JarVessel {
  if (count <= 2) return 'frasquito';
  if (count <= 5) return 'frasco';
  return 'frascote';
}

/** «La promesa» (0.0.93) — a goal jar's capacity: the TOP of each published
 *  jarSizeFor band (frasquito 2 · frasco 5 · frascote 8). By construction a
 *  full goal jar (N = jarCapacity(size)) satisfies jarSizeFor(N) === size, so
 *  a filled+auto-sealed promise is indistinguishable at rest from a pot jam of
 *  the same vessel. Published in the guide; the ONLY forward-facing count line
 *  («lleva n · le caben cap») lives solely on the pending jar's detail panel. */
export function jarCapacity(v: JarVessel): number {
  return v === 'frasquito' ? 2 : v === 'frasco' ? 5 : 8;
}

/** A goal jar (born empty at the wizard) vs an ordinary pot jam. */
export function isPromise(p: Preserve): boolean {
  return p.plannedAt != null;
}

/** A goal jar still filling — the only jar family that is NOT immutable
 *  history (its member fruits re-stamp in place; only a SEALED jar is final).
 *  Assumes a live record (repos already filter tombstones). */
export function isPending(p: Preserve): boolean {
  return isPromise(p) && !p.sealedAt;
}

/** A finished jam belonging on the alacena: a legacy pot jam (plannedAt
 *  absent) or a sealed promise. Everything that is NOT a pending goal jar.
 *  NOTE: elixirs also satisfy this (no plannedAt/sealedAt) — jam shelves must
 *  additionally exclude elixirs with !isElixir. */
export function isSealedJam(p: Preserve): boolean {
  return !isPending(p);
}

/** «La despedida» (0.0.95): a commemorative elixir vial vs an ordinary jam.
 *  Absent kind ≡ 'mermelada' (pre-v9 preserves). Elixirs live on their own
 *  shelf and must be excluded from every jam/promise shelf. */
export function isElixir(p: Preserve): boolean {
  return p.kind === 'elixir';
}

/** One shelf section of the pantry: a month and its fruits. */
export interface HarvestMonth {
  /** 'YYYY-MM' local month of harvestedAt. */
  key: string;
  items: Harvest[];
}

/** Months freshest-first; within a month, newest fruit first. Grouping
 *  only — never a count per month, never a comparison between months. */
export function harvestMonths(rows: Harvest[]): HarvestMonth[] {
  const byMonth = new Map<string, Harvest[]>();
  for (const row of rows) {
    const key = dayOf(row.harvestedAt).slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), row]);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] > b[0] ? -1 : 1))
    .map(([key, items]) => ({
      key,
      items: items.sort((a, b) => b.harvestedAt - a.harvestedAt || (a.id < b.id ? -1 : 1)),
    }));
}
