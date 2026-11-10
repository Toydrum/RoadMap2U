import { TreeNode } from './db/schema';
import { cadenceOf } from './cadence';
import { ritualKind } from './harvest';

/**
 * «El corazón del árbol» (0.0.112) — the PURE heart brain, sister of
 * harvest.ts. The owner's model: the node born with the tree's name is the
 * CENTER of the goal, not a task — its first little branches grow from it,
 * and when they all bloom, the tree blooms whole.
 *
 * THE RULE: the heart is the tree's FIRST visible root (derived — zero
 * schema; roots are never reorderable, so first-by-order is stable; a
 * persisted Tree.heartId stays documented as the v13 upgrade if that ever
 * changes). A heart WITH children is a CONTAINER: never suggested, never
 * pickable as a task, slim sheet, blooms only through the offered door. A
 * BARE heart is the goal itself: it keeps entering through the compass
 * doors that already special-case it (the first-pasito question, the
 * regadera «big» partition). Legacy extra roots (index > 0 — «+ Plantar
 * aquí» used to mint new trunks) stay ordinary tasks forever.
 */

/** A root-level node — the established predicate, now with one home. */
export function isRoot(n: TreeNode): boolean {
  return n.parentId === null;
}

/** The tree's heart: its first visible root by (order, createdAt, id) —
 *  the same stable tiebreak childrenIndex uses, so every device derives
 *  the same heart. `roots` must already be the tree's visible roots. */
export function heartOf(roots: readonly TreeNode[]): TreeNode | null {
  if (!roots.length) return null;
  return [...roots].sort(
    (a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )[0];
}

/** treeId → heartId over a by-tree map — for the PURE ranker. */
export function heartIds(nodesByTree: ReadonlyMap<string, TreeNode[]>): Set<string> {
  const ids = new Set<string>();
  for (const nodes of nodesByTree.values()) {
    const heart = heartOf(nodes.filter(isRoot));
    if (heart) ids.add(heart.id);
  }
  return ids;
}

/** A heart that has grown ramitas — the container that is never a task. */
export function isContainerHeart(
  node: TreeNode,
  heartIdSet: ReadonlySet<string>,
  childCount: number,
): boolean {
  return heartIdSet.has(node.id) && childCount > 0;
}

/**
 * «Cuando las ramitas estén completas, el árbol estará completo» — TRUE
 * when every visible descendant of the heart is achieved or branched
 * (branched IS a completed transformation; its alternatives are descendants
 * and answer for themselves), there is at least one, none of the LIVE ones
 * carries a cadence (a ritual breathes in cycles — the tree doesn't finish
 * while one is set; retiring it first is already the fruit law), and the
 * heart itself hasn't bloomed yet. `resting` BLOCKS: paused on purpose is
 * not finished — offering closure over a resting branch would be pressure
 * in costume.
 */
export function treeComplete(
  heart: TreeNode,
  childrenOf: (n: TreeNode) => TreeNode[],
  visibleRoots: readonly TreeNode[] = [],
): boolean {
  if (heart.status === 'achieved') return false;
  // A BRANCHED heart transformed — revertBranch is the ONLY exit from
  // branched (offering the bloom here was an illegal hand-exit that also
  // erased the golden knot from the month). And the heart's OWN cadence
  // blocks like any descendant's: a ritual breathes in cycles, and the
  // sweep would silently un-bloom the whole tree overnight (audit 0.0.115).
  if (heart.status === 'branched') return false;
  if (cadenceOf(heart) != null) return false;
  // Older Almanaque spirals were planted as separate roots. Keep their
  // location, but account for their rhythm when offering the tree's bloom.
  if (visibleRoots.some((root) => root.id !== heart.id && ritualKind(root) === 'leaf')) return false;
  let any = false;
  const stack = [...childrenOf(heart)];
  const seen = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    any = true;
    if (node.status !== 'achieved' && node.status !== 'branched') return false;
    // A leftover cadence on a BRANCHED node is inert (ritualKind already
    // rules branched out) — only a breathing ritual blocks.
    if (node.status !== 'branched' && cadenceOf(node) != null) return false;
    stack.push(...childrenOf(node));
  }
  return any;
}
