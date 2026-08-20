import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  type QuotaDecision,
  type QuotaSnapshot,
  preflightCreateTree,
  preflightPlantBranches,
  preflightRestoreBranches,
  preflightRestoreTree,
} from '../access/quota-policy';
import { AccessService } from '../access/access.service';
import { broadcastChange } from '../db/broadcast';
import { type StoreName, putAcrossOrMemory } from '../db/idb';
import { type AccentToken, type Tree, type TreeNode, newSyncBase } from '../db/schema';

export interface ForestMutationEntry {
  readonly store: StoreName;
  readonly rows: readonly unknown[];
}

/** Persistence seam: tests can hold/reject a commit without faking IndexedDB. */
export interface ForestMutationStorage {
  commit(entries: readonly ForestMutationEntry[]): Promise<void>;
}

export const FOREST_MUTATION_STORAGE = new InjectionToken<ForestMutationStorage>(
  'FOREST_MUTATION_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      commit: (entries) =>
        putAcrossOrMemory(entries.map((entry) => ({ store: entry.store, rows: [...entry.rows] }))),
    }),
  },
);

export interface ForestRecordsPort<T> {
  records(): readonly T[];
  publish(records: readonly T[]): void;
}

export type QuotaDenial = Exclude<QuotaDecision, { readonly allowed: true }>;

/** Domain error only. Features decide later how a denied growth is presented. */
export class ForestQuotaError extends Error {
  override readonly name = 'ForestQuotaError';

  constructor(readonly decision: QuotaDenial) {
    super(decision.reason);
  }
}

export class ForestMutationStateError extends Error {
  override readonly name = 'ForestMutationStateError';

  constructor(readonly code: 'FOREST_REPOSITORIES_NOT_READY') {
    super(code);
  }
}

/**
 * Coordinates commercial preflights over the complete local forest. Repos
 * register tiny state ports, so this service never injects them and Angular
 * has no TreesRepo <-> NodesRepo dependency cycle.
 */
@Injectable({ providedIn: 'root' })
export class ForestMutationsService {
  private readonly access = inject(AccessService);
  private readonly storage = inject(FOREST_MUTATION_STORAGE);

  private treesPort: ForestRecordsPort<Tree> | null = null;
  private nodesPort: ForestRecordsPort<TreeNode> | null = null;

  connectTrees(port: ForestRecordsPort<Tree>): void {
    this.treesPort = port;
  }

  connectNodes(port: ForestRecordsPort<TreeNode>): void {
    this.nodesPort = port;
  }

  async createTree(name: string, accent: AccentToken): Promise<Tree> {
    const snapshot = this.snapshot();
    const now = Date.now();
    const treeBase = newSyncBase(now);
    const heartBase = newSyncBase(now);
    const maxOrder = Math.max(
      0,
      ...snapshot.trees
        .filter((tree) => tree.deletedAt === null && tree.archivedAt === null)
        .map((tree) => tree.order),
    );
    const heart: TreeNode = {
      ...heartBase,
      treeId: treeBase.id,
      parentId: null,
      title: name,
      note: '',
      status: 'seed',
      order: 10,
      targetDate: null,
      achievedAt: null,
      branchedAt: null,
      origin: 'planned',
      archivedAt: null,
      trigger: null,
    };
    const tree: Tree = {
      ...treeBase,
      name,
      accent,
      order: maxOrder + 10,
      currentNodeId: heart.id,
      heartId: heart.id,
      archivedAt: null,
    };

    this.allow(preflightCreateTree(snapshot, tree, heart));
    await this.storage.commit([
      { store: 'trees', rows: [tree] },
      { store: 'nodes', rows: [heart] },
    ]);

    // Signals and sync broadcasts become visible only after the transaction
    // commits (or after the storage seam deliberately chose memory-only).
    this.treesPort!.publish([tree]);
    this.nodesPort!.publish([heart]);
    broadcastChange({ store: 'trees', ids: [tree.id] });
    broadcastChange({ store: 'nodes', ids: [heart.id] });
    return tree;
  }

  assertPlantBranches(treeId: string, count: number): void {
    this.allow(preflightPlantBranches(this.snapshot(), treeId, count));
  }

  assertRestoreBranches(records: readonly TreeNode[]): void {
    this.allow(preflightRestoreBranches(this.snapshot(), records));
  }

  assertRestoreTree(treeId: string): void {
    this.allow(preflightRestoreTree(this.snapshot(), treeId));
  }

  private snapshot(): QuotaSnapshot {
    if (!this.treesPort || !this.nodesPort) {
      throw new ForestMutationStateError('FOREST_REPOSITORIES_NOT_READY');
    }
    return {
      trees: this.treesPort.records(),
      nodes: this.nodesPort.records(),
      access: this.access.access(),
      leaseState: this.access.leaseState(),
    };
  }

  private allow(decision: QuotaDecision): void {
    if (!decision.allowed) throw new ForestQuotaError(decision);
  }
}
