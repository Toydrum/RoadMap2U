import { Injectable, inject } from '@angular/core';
import { API_CLIENT } from '../api/api-client';
import { ApiError, LIMITS, SyncRecord } from '../api/contracts';
import { SCHEMA_VERSION, Tree, TreeNode, stamp } from '../db/schema';
import { NodesRepo } from '../repos/nodes.repo';
import { TreesRepo } from '../repos/trees.repo';

/** The server caps a push at LIMITS.syncPushMax records — a guardian
 *  archiving a 100+ node subtree in the kid's forest must chunk like the
 *  real sync engine does, not fail wholesale. */
function chunked<T>(records: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < records.length; i += LIMITS.syncPushMax) {
    out.push(records.slice(i, i + LIMITS.syncPushMax));
  }
  return out;
}

/**
 * Route-scoped repo variants for visiting someone else's forest. They extend
 * the real repos so EVERY component and domain method (plant, branch, steps,
 * date review, setCurrentNode…) works unchanged — but the write funnel is
 * rerouted: instead of the visitor's IndexedDB, records travel through
 * POST /users/:id/sync/push (guardian write-through, rev-LWW). load() is a
 * no-op (VisitSession feeds resetTo), and read-only visits throw on writes —
 * belt and braces under the hidden affordances.
 */

@Injectable()
export class VisitTreesRepo extends TreesRepo {
  private readonly api = inject(API_CLIENT);
  private ownerId = '';
  private editable = false;

  protected override usesLocalForestMutations(): boolean {
    return false;
  }

  bind(ownerId: string, editable: boolean): void {
    this.ownerId = ownerId;
    this.editable = editable;
  }

  /** The visitor's disk is never read — VisitSession feeds the snapshot. */
  override async load(): Promise<void> {}

  override async save(record: Tree): Promise<Tree> {
    const stamped = stamp(record);
    await this.push([stamped]);
    return stamped;
  }

  override async insert(record: Tree): Promise<Tree> {
    await this.push([record]);
    return record;
  }

  override async saveMany(records: Tree[]): Promise<void> {
    await this.push(records);
  }

  private async push(records: Tree[]): Promise<void> {
    if (!this.editable || !this.ownerId) throw new ApiError('FORBIDDEN', 'view-only visit');
    for (const slice of chunked(records)) {
      const payload: SyncRecord[] = slice.map((record) => ({ store: 'trees', record }));
      const result = await this.api.pushSyncFor(this.ownerId, {
        schemaVersion: SCHEMA_VERSION,
        records: payload,
      });
      const rejectedIds = new Set(result.rejected.map((r) => r.id));
      for (const record of slice) {
        if (!rejectedIds.has(record.id)) this.applyLocal(record);
      }
      for (const winner of result.serverRecords) {
        if (winner.store === 'trees') this.applyExternal(winner.record as Tree);
      }
    }
  }
}

@Injectable()
export class VisitNodesRepo extends NodesRepo {
  private readonly api = inject(API_CLIENT);
  private ownerId = '';
  private editable = false;

  protected override usesLocalForestMutations(): boolean {
    return false;
  }

  bind(ownerId: string, editable: boolean): void {
    this.ownerId = ownerId;
    this.editable = editable;
  }

  override async load(): Promise<void> {}

  override async save(record: TreeNode): Promise<TreeNode> {
    const stamped = stamp(record);
    await this.push([stamped]);
    return stamped;
  }

  override async insert(record: TreeNode): Promise<TreeNode> {
    await this.push([record]);
    return record;
  }

  override async saveMany(records: TreeNode[]): Promise<void> {
    await this.push(records);
  }

  private async push(records: TreeNode[]): Promise<void> {
    if (!this.editable || !this.ownerId) throw new ApiError('FORBIDDEN', 'view-only visit');
    for (const slice of chunked(records)) {
      const payload: SyncRecord[] = slice.map((record) => ({ store: 'nodes', record }));
      const result = await this.api.pushSyncFor(this.ownerId, {
        schemaVersion: SCHEMA_VERSION,
        records: payload,
      });
      const rejectedIds = new Set(result.rejected.map((r) => r.id));
      for (const record of slice) {
        if (!rejectedIds.has(record.id)) this.applyLocal(record);
      }
      for (const winner of result.serverRecords) {
        if (winner.store === 'nodes') this.applyExternal(winner.record as TreeNode);
      }
    }
  }
}
