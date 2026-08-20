import { Component, input } from '@angular/core';
import type { TreeNode } from '../../core/db/schema';
import { FlowerSpec, flowerFor } from '../forest/flora';
import { FlowerGlyph } from '../forest/flower';
import { LayoutPoint, layoutTree, taperedRibbon } from '../forest/tree-layout';
import { formFor } from '../forest/tree-forms';
import {
  LeafDecoration,
  PadDecoration,
  leavesFor,
  padsFor,
  planLimbs,
  trunkFlarePath,
  trunkPath,
  woodFill,
  woodFor,
} from '../forest/tree-silhouette';

export type MarketingTreeVariant = 'hero' | 'sap' | 'branch' | 'grown' | 'demo';

interface MarketingLimb {
  id: string;
  d: string;
  fill: string;
}

interface MarketingPoint {
  id: string;
  x: number;
  y: number;
}

export interface MarketingTreeModel {
  transform: string;
  trunks: string[];
  flare: string[];
  limbs: MarketingLimb[];
  pads: PadDecoration[];
  leaves: LeafDecoration[];
  blooms: MarketingPoint[];
  knots: MarketingPoint[];
  buds: MarketingPoint[];
  flower: FlowerSpec;
}

function node(
  id: string,
  parentId: string | null,
  status: TreeNode['status'],
  order: number,
  origin: TreeNode['origin'] = 'planned',
): TreeNode {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    rev: 1,
    deletedAt: null,
    treeId: 'marketing-tree',
    parentId,
    title: id,
    note: '',
    status,
    order,
    targetDate: null,
    achievedAt: status === 'achieved' ? 1 : null,
    branchedAt: status === 'branched' ? 1 : null,
    origin,
    archivedAt: null,
    trigger: null,
  };
}

const STORY_NODES: TreeNode[] = [
  node('heart', null, 'growing', 10),
  node('path-a', 'heart', 'achieved', 10),
  node('path-b', 'heart', 'growing', 20),
  node('path-c', 'heart', 'branched', 30),
  node('path-d', 'heart', 'growing', 40),
  node('step-a1', 'path-a', 'achieved', 10),
  node('step-a2', 'path-a', 'growing', 20),
  node('step-b1', 'path-b', 'achieved', 10),
  node('step-b2', 'path-b', 'seed', 20),
  node('route-c1', 'path-c', 'growing', 10, 'branch'),
  node('route-c2', 'path-c', 'resting', 20, 'branch'),
];

/**
 * Product-demo tree built with the exact pure layout and silhouette modules
 * used by the app. The hero and three step silhouettes remain the approved
 * prototype vectors; this model proves the marketing surface speaks the real
 * product's deterministic drawing language without importing its live canvas.
 */
export function marketingTreeModel(): MarketingTreeModel {
  const childrenOf = (parent: TreeNode): TreeNode[] =>
    STORY_NODES.filter((candidate) => candidate.parentId === parent.id).sort(
      (a, b) => a.order - b.order,
    );
  const roots = STORY_NODES.filter((candidate) => candidate.parentId === null);
  const layout = layoutTree(roots, childrenOf);
  const form = formFor('moss', 'marketing-tree');
  const wood = woodFor('marketing-tree', form);
  const isTip = (point: LayoutPoint): boolean =>
    childrenOf(point.node).length === 0 && !point.chainNextId;
  const plans = planLimbs(layout.points, form, wood, 'marketing-tree', isTip);
  const groundY = 80;
  const scale = 0.76;
  const centerX = layout.minX + layout.width / 2;
  const transform = `translate(${(260 - centerX * scale).toFixed(2)} 304) scale(${scale})`;

  const limbs: MarketingLimb[] = [];
  const pads: PadDecoration[] = [];
  const leaves: LeafDecoration[] = [];
  for (const point of layout.points) {
    if (!point.parent) continue;
    const plan = plans.get(point.node.id);
    if (!plan) continue;
    limbs.push({
      id: point.node.id,
      d: taperedRibbon(
        plan.start.x,
        plan.start.y,
        plan.geom.c1x,
        plan.geom.c1y,
        plan.geom.c2x,
        plan.geom.c2y,
        point.x,
        point.y,
        plan.w0,
        plan.w1,
      ),
      fill: woodFill(point, wood),
    });
    pads.push(...padsFor(point, plan.start, plan.geom, plan.isLeaf, form));
    leaves.push(...leavesFor(point, plan.start, plan.geom, form));
  }

  const points = (status: TreeNode['status']): MarketingPoint[] =>
    layout.points
      .filter((point) => point.node.status === status)
      .map((point) => ({ id: point.node.id, x: point.x, y: point.y }));

  return {
    transform,
    trunks: roots.map((root) => trunkPath(layout.byId.get(root.id)!, groundY, wood, form, 10)),
    flare: roots.map((root) => trunkFlarePath(layout.byId.get(root.id)!, groundY, wood, form, 10)),
    limbs,
    pads,
    leaves,
    blooms: points('achieved'),
    knots: points('branched'),
    buds: [...points('growing'), ...points('seed')],
    flower: flowerFor('moss', 'marketing-tree'),
  };
}

@Component({
  selector: 'app-marketing-tree',
  imports: [FlowerGlyph],
  templateUrl: './marketing-tree.html',
  styleUrl: './marketing-tree.scss',
})
export class MarketingTree {
  readonly variant = input<MarketingTreeVariant>('hero');
  protected readonly model = marketingTreeModel();
}
