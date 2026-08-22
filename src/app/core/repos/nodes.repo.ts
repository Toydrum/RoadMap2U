import { Injectable, computed, inject } from '@angular/core';
import { NodeStatus, TreeNode, lightRank, newSyncBase, stamp } from '../db/schema';
import { StoreName } from '../db/idb';
import { RecordsRepo } from './records.repo';
import { Cadence, cadenceOf } from '../cadence';
import { isPast } from '../time';
import { ForestMutationsService } from './forest-mutations.service';

export interface NewNodeDraft {
  title: string;
  note?: string;
  targetDate?: string | null;
  /** «El ritmo» (0.0.103): plant a ritual right at intent time. Writers
   *  must mirror the repeatsDaily compat shadow (plant() does). */
  repeats?: TreeNode['repeats'];
}

export interface PlantNodeDraft extends NewNodeDraft {
  parentId: string | null;
}

@Injectable({ providedIn: 'root' })
export class NodesRepo extends RecordsRepo<TreeNode> {
  protected readonly store: StoreName = 'nodes';
  private readonly forestMutations = inject(ForestMutationsService);

  constructor() {
    super();
    if (this.usesLocalForestMutations()) {
      this.forestMutations.connectNodes({
        records: () => [...this.byId().values()],
        publish: (records) => {
          for (const record of records) this.applyLocal(record);
        },
      });
    }
  }

  /** Route-scoped visit repos rely on the visited owner's server authority. */
  protected usesLocalForestMutations(): boolean {
    return true;
  }

  /** Visible nodes (not tombstoned, not archived). */
  readonly visible = computed(() => this.all().filter((n) => !n.archivedAt));

  readonly byTree = computed(() => {
    const map = new Map<string, TreeNode[]>();
    for (const node of this.visible()) {
      const list = map.get(node.treeId) ?? [];
      list.push(node);
      map.set(node.treeId, list);
    }
    return map;
  });

  /** parentId ('root' for null) → ordered children. */
  readonly childrenIndex = computed(() => {
    const map = new Map<string, TreeNode[]>();
    for (const node of this.visible()) {
      const key = node.parentId ?? `root:${node.treeId}`;
      const list = map.get(key) ?? [];
      list.push(node);
      map.set(key, list);
    }
    // Stable tiebreak (0.0.112): order ties used to fall back to Map
    // insertion order — two devices could derive a DIFFERENT first root
    // (the heart). createdAt then id settles every sibling everywhere.
    for (const list of map.values())
      list.sort(
        (a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
      );
    return map;
  });

  /** Nodes whose gentle date has passed and is still unhandled — sunlit
   *  conversations first, then oldest date, deterministic tail. A RITUAL's
   *  date is dead data (the almanac ignores it while a cadence is set), so
   *  the 🍂 banners must not advocate for it either (0.0.108) — the date
   *  persists silently and its conversation returns if the rhythm clears. */
  readonly needsDateReview = computed(() =>
    this.visible()
      .filter(
        (n) =>
          n.targetDate !== null &&
          isPast(n.targetDate) &&
          cadenceOf(n) == null &&
          // A container HEART's date is invisible on its slim sheet (0.0.112)
          // — three banners advocating for a field the user can't see or edit
          // is the 0.0.108 wound again. The date persists silently; the
          // conversation returns if the heart ever goes bare again.
          !(
            n.parentId === null &&
            this.heartOf(n.treeId)?.id === n.id &&
            this.childrenOf(n).length > 0
          ) &&
          n.status !== 'achieved' &&
          n.status !== 'branched',
      )
      .sort(
        (a, b) =>
          lightRank(a) - lightRank(b) ||
          (a.targetDate ?? '').localeCompare(b.targetDate ?? '') ||
          a.id.localeCompare(b.id),
      ),
  );

  childrenOf(node: TreeNode): TreeNode[] {
    return this.childrenIndex().get(node.id) ?? [];
  }

  rootsOf(treeId: string): TreeNode[] {
    return this.childrenIndex().get(`root:${treeId}`) ?? [];
  }

  /** «El corazón del árbol» (0.0.112): the first visible root — the node
   *  born with the tree. Visits inherit this via VisitNodesRepo. */
  heartOf(treeId: string): TreeNode | null {
    return this.rootsOf(treeId)[0] ?? null;
  }

  async plant(treeId: string, parentId: string | null, draft: NewNodeDraft): Promise<TreeNode> {
    const [node] = await this.plantMany(treeId, [{ parentId, ...draft }]);
    return node;
  }

  /** Validate a whole user gesture before its first write. Multi-line sowing
   *  creates parent/child records in sequence, so this preflight prevents a
   *  quota denial halfway through the pasted outline. */
  assertCanPlant(treeId: string, count: number): void {
    if (this.usesLocalForestMutations()) {
      this.forestMutations.assertPlantBranches(treeId, count);
    }
  }

  /** One gesture, one aggregate quota decision, one nodes transaction. */
  async plantMany(treeId: string, drafts: readonly PlantNodeDraft[]): Promise<TreeNode[]> {
    if (!drafts.length) return [];
    this.assertCanPlant(treeId, drafts.length);
    const now = Date.now();
    const nextOrder = new Map<string, number>();
    const nodes = drafts.map((draft) => {
      const siblingKey = draft.parentId ?? `root:${treeId}`;
      const existing = draft.parentId
        ? (this.childrenIndex().get(draft.parentId) ?? [])
        : this.rootsOf(treeId);
      const order =
        (nextOrder.get(siblingKey) ?? Math.max(0, ...existing.map((sibling) => sibling.order))) +
        10;
      nextOrder.set(siblingKey, order);
      return {
        ...newSyncBase(now),
        treeId,
        parentId: draft.parentId,
        title: draft.title,
        note: draft.note ?? '',
        status: 'seed' as const,
        order,
        targetDate: draft.targetDate ?? null,
        achievedAt: null,
        branchedAt: null,
        origin: 'planned' as const,
        archivedAt: null,
        trigger: null,
        // A ritual planted at intent time — compat shadow mirrored, freeze
        // boundary stamped (a newborn has no history, but the stamp keeps
        // every ritual under one law).
        ...(draft.repeats != null
          ? { repeats: draft.repeats, repeatsDaily: true, repeatsSetAt: now }
          : {}),
      } satisfies TreeNode;
    });
    await this.saveMany(nodes);
    return nodes;
  }

  /** THE cadence writer (cadenceOf is the one reader; this + plant are the
   *  only writers). Mirrors the repeatsDaily compat shadow; stamps
   *  repeatsSetAt on the null→rhythm transition («la historia se queda» —
   *  the freeze boundary), keeps it when the rhythm merely changes kind,
   *  clears it with the cadence. `wake` re-seeds an anciently-bloomed leaf
   *  IN THE USER'S HANDS (the caller asked first) — never overnight. */
  async setCadence(node: TreeNode, c: Cadence | null, wake = false): Promise<TreeNode> {
    const first = c != null && !cadenceOf(node);
    return this.save({
      ...node,
      repeats: c,
      repeatsDaily: c != null,
      repeatsSetAt: c == null ? null : first ? Date.now() : (node.repeatsSetAt ?? null),
      ...(wake ? { status: 'seed' as const, achievedAt: null } : {}),
    });
  }

  async setStatus(node: TreeNode, status: NodeStatus): Promise<TreeNode> {
    // Reopening a bloomed branch takes its bloom stamp with it — a stale
    // achievedAt painted phantom flowers on the almanaque and survived
    // stone-bloom undos forever. Branching keeps it (both events happened).
    const reopened = status === 'seed' || status === 'growing' || status === 'resting';
    return this.save({
      ...node,
      status,
      achievedAt: status === 'achieved' ? Date.now() : reopened ? null : node.achievedAt,
    });
  }

  async update(
    node: TreeNode,
    patch: Partial<
      Pick<
        TreeNode,
        | 'title'
        | 'note'
        | 'targetDate'
        | 'trigger'
        | 'flow'
        | 'priority'
        | 'estimateMin'
        | 'repeatsDaily'
        | 'repeats'
        | 'remindAt'
      >
    >,
  ): Promise<TreeNode> {
    return this.save({ ...node, ...patch });
  }

  /** Swap a step with its neighbor — the app's first node reorder. Both
   *  records re-stamp in one atomic write; a no-op at either end. */
  async moveStep(node: TreeNode, dir: -1 | 1): Promise<void> {
    const siblings = node.parentId
      ? (this.childrenIndex().get(node.parentId) ?? [])
      : this.rootsOf(node.treeId);
    const idx = siblings.findIndex((s) => s.id === node.id);
    const other = siblings[idx + dir];
    if (idx === -1 || !other) return;
    const now = Date.now();
    await this.saveMany([
      stamp({ ...node, order: other.order }, now),
      stamp({ ...other, order: node.order }, now),
    ]);
  }

  /** Returns the archived records so callers can offer an undo. */
  async archiveSubtree(node: TreeNode): Promise<TreeNode[]> {
    const now = Date.now();
    const toArchive: TreeNode[] = [];
    const walk = (current: TreeNode) => {
      toArchive.push(stamp({ ...current, archivedAt: now }, now));
      for (const child of this.childrenOf(current)) walk(child);
    };
    walk(node);
    await this.saveMany(toArchive);
    return toArchive;
  }

  /** Inverse of archiveSubtree — one atomic write. Re-reads live records and
   *  re-stamps so the restore's rev moves PAST the archive write (cross-tab
   *  LWW accepts it); already-restored records are skipped (double-tap safe). */
  async unarchiveMany(records: TreeNode[]): Promise<void> {
    const now = Date.now();
    const fresh = [...new Map(records.map((record) => [record.id, record])).values()]
      .map((record) => this.byId().get(record.id) ?? record)
      .filter((r) => r.archivedAt !== null)
      .map((r) => stamp({ ...r, archivedAt: null }, now));
    if (!fresh.length) return;
    if (this.usesLocalForestMutations()) {
      this.forestMutations.assertRestoreBranches(fresh);
    }
    await this.saveMany(fresh);
  }

  /** Permanent removal (sync tombstones) for a whole tree's nodes — atomic. */
  async tombstoneMany(records: TreeNode[]): Promise<void> {
    const now = Date.now();
    await this.saveMany(records.map((n) => stamp({ ...n, deletedAt: now }, now)));
  }

  /**
   * The heart: a passed date becomes a branch point. Atomic — parent flips to
   * 'branched' (original targetDate preserved as history) and the alternatives
   * are born in the same IndexedDB transaction.
   */
  async branch(parent: TreeNode, alternatives: NewNodeDraft[]): Promise<TreeNode[]> {
    if (this.usesLocalForestMutations()) {
      this.forestMutations.assertPlantBranches(parent.treeId, alternatives.length);
    }
    const now = Date.now();
    const branchedParent = stamp(
      { ...parent, status: 'branched' as NodeStatus, branchedAt: now },
      now,
    );
    const children = alternatives.map((draft, i) => ({
      ...newSyncBase(now),
      treeId: parent.treeId,
      parentId: parent.id,
      title: draft.title,
      note: draft.note ?? '',
      status: 'seed' as NodeStatus,
      order: (i + 1) * 10,
      targetDate: draft.targetDate ?? null,
      achievedAt: null,
      branchedAt: null,
      origin: 'branch' as const,
      archivedAt: null,
      trigger: null,
    }));
    await this.saveMany([branchedParent, ...children]);
    return children;
  }

  /**
   * The only exit from 'branched' — undo of a branching, atomic. The parent
   * leaves the knot and its origin:'branch' children leave with it as sync
   * tombstones (archived nodes are invisible in every UI; a tombstone is the
   * honest shape, still travels in backups). Default landing is 'growing' +
   * dateless: a preserved past targetDate must NOT re-arm date-review
   * (mirrors date-review's keepGoing). Returns the removed children so the
   * caller can repair the tree's currentNodeId.
   */
  async revertBranch(
    parent: TreeNode,
    restoreTo: { status: NodeStatus; targetDate: string | null } = {
      status: 'growing',
      targetDate: null,
    },
  ): Promise<TreeNode[]> {
    const now = Date.now();
    // ALL branch-born children, archived ones included — childrenOf reads
    // the visible index, so an individually-archived branch child survived
    // the revert invisibly under a now-growing parent (and could resurface
    // via unarchive).
    const children = this.all().filter(
      (c) => c.parentId === parent.id && c.origin === 'branch' && !c.deletedAt,
    );
    const reverted = stamp(
      { ...parent, status: restoreTo.status, targetDate: restoreTo.targetDate, branchedAt: null },
      now,
    );
    await this.saveMany([reverted, ...children.map((c) => stamp({ ...c, deletedAt: now }, now))]);
    return children;
  }
}
