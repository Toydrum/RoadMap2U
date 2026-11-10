import { TreeNode } from '../../core/db/schema';
// hash moved to core/hash.ts (0.0.115) — re-exported so every flora caller
// keeps its historical import path (layout, jitter, species, tints…).
import { hash } from '../../core/hash';
export { hash };

/**
 * Pure tree layout: leaf-slot layered algorithm with deterministic organic
 * jitter. Root(s) at the bottom, growth goes UP (y decreases with depth).
 *
 * Post-order walk — each leaf takes the next x slot; each parent centers over
 * its descendants' slot span. Subtree spans are disjoint, so overlap is
 * impossible by construction. Jitter is a hash of the node's stable UUID, so
 * the tree NEVER reshuffles between sessions.
 */

export interface LayoutPoint {
  node: TreeNode;
  x: number;
  y: number;
  depth: number;
  parent: LayoutPoint | null;
  /** The node's visual row line (pre-jitter, lift included) — labels anchor
   *  here so they ride with their branch instead of drifting to a nominal row. */
  rowY?: number;
  /** Subtree leaf-mass (leaves carry 1; parents sum their children) — feeds
   *  the da Vinci width law: limbs are as thick as what they carry. */
  mass?: number;
  /** True for links of an ordered-steps chain ('flow: steps' pasitos). */
  chain?: boolean;
  /** The next link up the chain, when this one isn't the last. */
  chainNextId?: string;
}

export interface TreeLayout {
  points: LayoutPoint[];
  byId: Map<string, LayoutPoint>;
  width: number;
  height: number;
  minX: number;
  minY: number;
}

export const SLOT_W = 78;
export const LEVEL_H = 100;
const JITTER_X = 8;
const JITTER_Y = 8;
/** Sibling count at which the two-row "vase" canopy kicks in. */
const STAGGER_MIN = 4;
/** Leaf slot advance inside a staggered fan — the two rows interleave, so
 *  same-row neighbors stay ~2 slots apart while the fan stops sprawling. */
const TIGHT = 0.62;
/** Extra rise for children that carry their own crown — subtrees grow UP
 *  instead of pulling the canopy sideways. Propagates to the whole crown. */
const CROWN_LIFT = 26;
/** Segment height of an ordered-steps chain — short links, one filling limb. */
const CHAIN_H = 46;

export function layoutTree(
  roots: TreeNode[],
  childrenOf: (node: TreeNode) => TreeNode[],
): TreeLayout {
  const points: LayoutPoint[] = [];
  const byId = new Map<string, LayoutPoint>();
  let cursor = 0;

  // Ordered-steps prepass: a 'steps' parent shows only its FIRST pasito in
  // the traversal; each step then carries the next one — the siblings render
  // as one chain of short segments (the path that fills with flowers).
  const chainNext = new Map<string, TreeNode>();
  const stepsParents = new Set<string>();
  const scan = (node: TreeNode) => {
    const kids = childrenOf(node);
    if (node.flow === 'steps' && kids.length > 0) {
      stepsParents.add(node.id);
      for (let i = 0; i < kids.length - 1; i++) chainNext.set(kids[i].id, kids[i + 1]);
    }
    for (const k of kids) scan(k);
  };
  for (const root of roots) scan(root);

  /** Traversal children: own subtree (chain-rewritten) + the next chain link. */
  const kidsOf = (node: TreeNode): TreeNode[] => {
    const own = childrenOf(node);
    const shown = stepsParents.has(node.id) ? (own.length ? [own[0]] : []) : own;
    const next = chainNext.get(node.id);
    return next ? [...shown, next] : shown;
  };

  // Count visible leaf slots after rewriting ordered paths: a long chain
  // alone does not make a wide canopy. Both the map and miniature use this
  // shape, so the same tree stays recognizable at every viewport size.
  const countLeaves = (node: TreeNode): number => {
    const children = kidsOf(node);
    return children.length ? children.reduce((sum, child) => sum + countLeaves(child), 0) : 1;
  };
  const leaves = roots.reduce((sum, root) => sum + countLeaves(root), 0);
  const density = Math.min(1, Math.max(0, (leaves - 16) / 28));
  const levelHeight = LEVEL_H + 60 * density;
  const slotWidth = SLOT_W * (1 - 0.14 * density);

  const place = (
    node: TreeNode,
    depth: number,
    parent: LayoutPoint | null,
    sibIndex: number,
    sibCount: number,
    parentRowY: number,
    chainish: boolean,
  ): { point: LayoutPoint; baseX: number; leaves: number } => {
    const children = kidsOf(node);
    const nominalY = parent === null ? 0 : parentRowY - (chainish ? CHAIN_H : levelHeight);

    // Two-row "vase" canopy: big sibling groups alternate between two rows
    // (S) and sweep their OUTER limbs upward (V); children that carry a crown
    // rise further (CROWN_LIFT) — the tree grows UP, not just sideways.
    // Computed BEFORE recursing so the lift carries the whole subtree with it.
    // Deterministic from (index, count); roots and chain links exempt.
    let lift = 0;
    if (parent !== null && !chainish && sibCount >= STAGGER_MIN) {
      const t = (sibIndex + 0.5) / sibCount;
      const s = Math.min(30, 16 + sibCount * 1.8);
      const v = Math.min(14, (sibCount - 3) * 2.5);
      // Broad canopies also lift every third limb into a higher shelf.
      // Blend in the extra rise as the canopy gains leaves.
      const stagger =
        s * (sibIndex % 2) * (1 - density) +
        56 * (sibIndex % (sibCount >= 6 ? 3 : 2)) * density;
      lift = Math.min(
        64 + 90 * density,
        stagger + v * Math.pow(Math.abs(2 * t - 1), 1.5) + (children.length ? CROWN_LIFT : 0),
      );
    }
    const rowY = nominalY - lift;
    const point: LayoutPoint = { node, x: 0, y: 0, depth, parent, rowY };
    if (chainish) {
      point.chain = true;
      const next = chainNext.get(node.id);
      if (next) point.chainNextId = next.id;
    }

    // baseX is jitter-free so ancestors center on real mass, not on wobble.
    let baseX: number;
    let leaves: number;
    if (children.length === 0) {
      baseX = cursor;
      cursor += slotWidth * (sibCount >= STAGGER_MIN ? TIGHT : 1);
      leaves = 1;
    } else {
      // Fan geometry (stagger/tightening) counts only the real fan children;
      // a trailing chain link rides along without weighing on the vase.
      const fan = children.filter((c) => c !== chainNext.get(node.id));
      const placed = children.map((child) => {
        const isLink = child === chainNext.get(node.id);
        const fanIdx = isLink ? 0 : fan.indexOf(child);
        return place(
          child,
          isLink ? depth : depth + 1,
          point,
          fanIdx,
          isLink ? 1 : fan.length,
          rowY,
          isLink || stepsParents.has(node.id),
        );
      });
      let mass = 0;
      let sum = 0;
      for (const p of placed) {
        sum += p.baseX * p.leaves;
        mass += p.leaves;
      }
      // Leaf-mass centroid: the hub sits under the canopy's visual weight
      // (midpoint-of-extremes dragged lopsided parents into no-man's-land).
      baseX = sum / mass;
      leaves = mass;
    }

    const h = hash(node.id);
    point.x = baseX + ((h % (JITTER_X * 2 + 1)) - JITTER_X);
    point.y = rowY + (((h >> 7) % (JITTER_Y * 2 + 1)) - JITTER_Y);
    point.mass = leaves;

    points.push(point);
    byId.set(node.id, point);
    return { point, baseX, leaves };
  };

  for (let r = 0; r < roots.length; r++) place(roots[r], 0, null, r, roots.length, 0, false);

  if (!points.length) {
    return { points, byId, width: 0, height: 0, minX: 0, minY: 0 };
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    points,
    byId,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
    minX,
    minY,
  };
}

export interface EdgeGeometry {
  d: string;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
}

export interface EdgeOpts {
  /** 0..1 — mixes the arrival tangent toward straight-up. 0 = classic curve. */
  upBias?: number;
  /** Multiplies the bow (sinuosity). 1 = classic. */
  bowMul?: number;
  /** Fixes the bow's handedness (leader-axis continuity) instead of h%2. */
  hand?: 1 | -1;
}

/** Wood width from carried leaf-mass (da Vinci: area ∝ mass) — twig floor,
 *  fan ceiling. Trees thicken as they grow; a one-leaf baby stays a stem. */
export function widthForMass(mass: number, girth = 1): number {
  return Math.min(30, Math.max(2.4, 5.2 * girth * Math.sqrt(Math.max(1, mass))));
}

/** The ribbon's eased half-width at parameter t — where a side branch forks
 *  off a limb, its collar must match the wood it grows from. */
export function ribbonWidthAt(w0: number, w1: number, t: number): number {
  const eased = t * t * (3 - 2 * t);
  return w0 + (w1 - w0) * eased;
}

/**
 * Organic cubic bezier from parent to child (child sits above the parent).
 * Thick limbs bow more; twigs stay tighter — the vecteezy-silhouette look.
 * `bowScale` lets miniature renders damp the curvature (absolute bow values
 * over compressed coordinates read as seaweed otherwise).
 */
export function edgeGeometry(
  parent: { x: number; y: number },
  child: LayoutPoint,
  bowScale = 1,
  opts: EdgeOpts = {},
): EdgeGeometry {
  const dx = child.x - parent.x;
  const dy = child.y - parent.y; // negative (upward)
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // The bow rides the limb's PERPENDICULAR: vertical limbs render exactly as
  // before (their perpendicular IS horizontal), while slanted limbs arc
  // sideways instead of cusping into an S along the x axis.
  const nx = -uy;
  const ny = ux;
  const h = hash(child.node.id);
  const hand = opts.hand ?? (h % 2 === 0 ? 1 : -1);
  const bowBase = 14 + (h % 18);
  const shallow = 0.65 + 0.35 * Math.abs(uy); // near-horizontal limbs bow less
  const bow =
    hand * bowBase * Math.max(0.5, 1.4 - child.depth * 0.18) * bowScale * shallow * (opts.bowMul ?? 1);
  const c1x = parent.x + ux * (len * 0.45) + nx * (bow * 0.5);
  const c1y = parent.y + uy * (len * 0.45) + ny * (bow * 0.5);
  // Arrival: mix the limb direction toward straight-up (phototropism) — at
  // upBias 0 this is byte-identical to the classic c2.
  const b = opts.upBias ?? 0;
  const mx = ux * (1 - b);
  const my = uy * (1 - b) - b;
  const ml = Math.hypot(mx, my) || 1;
  const c2x = child.x - (mx / ml) * (len * 0.35) - nx * (bow * 0.7 * (1 - b));
  const c2y = child.y - (my / ml) * (len * 0.35) - ny * (bow * 0.7 * (1 - b));
  return {
    d: `M ${parent.x} ${parent.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${child.x} ${child.y}`,
    c1x,
    c1y,
    c2x,
    c2y,
  };
}

/** Point at parameter t along the edge's cubic bezier (for leaf placement). */
export function edgePointAt(
  parent: { x: number; y: number },
  child: { x: number; y: number },
  geometry: EdgeGeometry,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const x =
    u * u * u * parent.x + 3 * u * u * t * geometry.c1x + 3 * u * t * t * geometry.c2x + t * t * t * child.x;
  const y =
    u * u * u * parent.y + 3 * u * u * t * geometry.c1y + 3 * u * t * t * geometry.c2y + t * t * t * child.y;
  return { x, y };
}


/**
 * A branch as a FILLED tapered ribbon (not a uniform stroke): the cubic
 * centerline is sampled, offset perpendicular by a half-width that eases
 * from the parent's wood width to the child's — smooth joints, no sausage
 * caps, real timber.
 */
export function taperedRibbon(
  x0: number,
  y0: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
): string {
  const N = 14;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
    const dx = 3 * u * u * (c1x - x0) + 6 * u * t * (c2x - c1x) + 3 * t * t * (x1 - c2x);
    const dy = 3 * u * u * (c1y - y0) + 6 * u * t * (c2y - c1y) + 3 * t * t * (y1 - c2y);
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    // ease the taper so limbs stay sturdy near the joint and slim at the tip
    const eased = t * t * (3 - 2 * t);
    const hw = (w0 + (w1 - w0) * eased) / 2;
    left.push(`${(x + nx * hw).toFixed(1)} ${(y + ny * hw).toFixed(1)}`);
    right.push(`${(x - nx * hw).toFixed(1)} ${(y - ny * hw).toFixed(1)}`);
  }
  return `M ${left[0]} L ${left.slice(1).join(' L ')} L ${right.reverse().join(' L ')} Z`;
}

/** Ribbon for a limb from an arbitrary start point to its node — widths are
 *  supplied by the caller (the mass-width law lives at the component layer,
 *  where the tree's form/girth are known). */
export function branchRibbon(
  start: { x: number; y: number },
  child: LayoutPoint,
  geometry: EdgeGeometry,
  w0: number,
  w1: number,
): string {
  return taperedRibbon(
    start.x,
    start.y,
    geometry.c1x,
    geometry.c1y,
    geometry.c2x,
    geometry.c2y,
    child.x,
    child.y,
    w0,
    w1,
  );
}
