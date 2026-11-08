import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  type AccessLeaseState,
  type QuotaDecision,
  type QuotaSnapshot,
  preflightCreateTree,
  preflightImport,
  preflightPlantBranches,
  preflightRestoreBranches,
  preflightRestoreTree,
  preflightSeed,
} from '../access/quota-policy';
import { AccessService } from '../access/access.service';
import type { AccessSummary } from '../api/contracts';
import { broadcastMutation } from '../db/broadcast';
import { type StoreName, getAll, putAcrossOrMemory, replaceAll, replaceAllIfEmpty } from '../db/idb';
import { type AccentToken, type Tree, type TreeNode, newSyncBase } from '../db/schema';

export interface ForestMutationEntry {
  readonly store: StoreName;
  readonly rows: readonly unknown[];
}

export interface ForestReplacementEntry {
  readonly store: StoreName;
  readonly rows: unknown[];
}

export interface ForestReplacementStorage {
  replace(entries: ForestReplacementEntry[]): Promise<void>;
  replaceIfEmpty(entries: ForestReplacementEntry[]): Promise<boolean>;
}

/** One replace transaction for import and the explicit local demo seed. */
export const FOREST_REPLACEMENT_STORAGE = new InjectionToken<ForestReplacementStorage>(
  'FOREST_REPLACEMENT_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      replace: (entries) => replaceAll(entries),
      replaceIfEmpty: (entries) => replaceAllIfEmpty(entries),
    }),
  },
);

export interface ForestAccessContext {
  readonly access: AccessSummary;
  readonly leaseState: AccessLeaseState;
}

/** Persistence seam: tests can hold/reject a commit without faking IndexedDB. */
export interface ForestMutationStorage {
  commit(entries: readonly ForestMutationEntry[]): Promise<void>;
  readQuotaRecords?(): Promise<Pick<QuotaSnapshot, 'trees' | 'nodes'>>;
}

export const FOREST_MUTATION_STORAGE = new InjectionToken<ForestMutationStorage>(
  'FOREST_MUTATION_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      commit: (entries) =>
        putAcrossOrMemory(entries.map((entry) => ({ store: entry.store, rows: [...entry.rows] }))),
      async readQuotaRecords() {
        const [trees, nodes] = await Promise.all([getAll<Tree>('trees'), getAll<TreeNode>('nodes')]);
        return { trees, nodes };
      },
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
  private pendingQuotaMutation: Promise<unknown> | null = null;

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

    return this.commitWithinQuota((current) => preflightCreateTree(current, tree, heart), async () => {
      await this.storage.commit([
        { store: 'trees', rows: [tree] },
        { store: 'nodes', rows: [heart] },
      ]);
      this.treesPort!.publish([tree]);
      this.nodesPort!.publish([heart]);
      broadcastMutation([
        { store: 'trees', ids: [tree.id] },
        { store: 'nodes', ids: [heart.id] },
      ]);
      return tree;
    });
  }

  /** Hold one forest-wide lock until both disk and the local repositories agree. */
  async commitWithinQuota<T>(
    check: (snapshot: QuotaSnapshot) => QuotaDecision,
    commit: () => Promise<T>,
  ): Promise<T> {
    const run = async () => {
      let snapshot = this.snapshot();
      if (this.storage.readQuotaRecords && snapshot.access.effectivePlanKey === 'free') {
        const persisted = await this.storage.readQuotaRecords().catch(() => null);
        snapshot = { ...this.snapshot(), ...persisted };
      }
      this.allow(check(snapshot));
      return commit();
    };
    // Tabs may still be processing a previous writer's broadcast. Read the
    // shared stores under the lock so the last slot cannot be claimed twice.
    if (globalThis.navigator?.locks && this.storage.readQuotaRecords) {
      return navigator.locks.request('roadmap2u:forest-quota', run);
    }
    const pending = this.pendingQuotaMutation;
    const request = pending ? pending.then(run, run) : run();
    this.pendingQuotaMutation = request;
    try {
      return await request;
    } finally {
      if (this.pendingQuotaMutation === request) this.pendingQuotaMutation = null;
    }
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

  /** One decision over the complete replacement candidate. */
  assertImport(trees: readonly Tree[], nodes: readonly TreeNode[]): void {
    this.allow(preflightImport(this.snapshot(), trees, nodes));
  }

  /** Seed policy normally uses the signed-in lease. The local mock showcase
   *  passes its explicit, bounded Premium fixture by construction. */
  assertSeed(
    trees: readonly Tree[],
    nodes: readonly TreeNode[],
    context?: ForestAccessContext,
  ): void {
    const snapshot = this.snapshot();
    this.allow(preflightSeed(context ? { ...snapshot, ...context } : snapshot, trees, nodes));
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
