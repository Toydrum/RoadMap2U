import { Injectable, computed, inject } from '@angular/core';
import { AccentToken, Tree, stamp } from '../db/schema';
import { StoreName } from '../db/idb';
import { RecordsRepo } from './records.repo';
import { ForestMutationsService } from './forest-mutations.service';

@Injectable({ providedIn: 'root' })
export class TreesRepo extends RecordsRepo<Tree> {
  protected readonly store: StoreName = 'trees';
  private readonly forestMutations = inject(ForestMutationsService);

  constructor() {
    super();
    if (this.usesLocalForestMutations()) {
      this.forestMutations.connectTrees({
        records: () => [...this.byId().values()],
        publish: (records) => {
          for (const record of records) this.applyLocal(record);
        },
      });
    }
  }

  /** Route-scoped visit repos write someone else's forest through the API. */
  protected usesLocalForestMutations(): boolean {
    return true;
  }

  readonly active = computed(() =>
    this.all()
      .filter((t) => !t.archivedAt)
      .sort((a, b) => a.order - b.order),
  );

  readonly archived = computed(() => this.all().filter((t) => t.archivedAt));

  /** Persist a user-arranged order (gap-numbered so future inserts stay easy). */
  async setOrder(ids: string[]): Promise<void> {
    const byId = this.byId();
    const updates: Tree[] = [];
    const now = Date.now();
    ids.forEach((id, index) => {
      const tree = byId.get(id);
      const order = (index + 1) * 10;
      // stamp() is on us: saveMany persists AS-IS (unlike save) — an
      // unstamped reorder ties the server's rev and LWW hands the old order
      // back two seconds after the drag. Archived ids (a cross-tab archive
      // mid-drag can leave one in the preview) are left untouched.
      if (tree && !tree.archivedAt && tree.order !== order) {
        updates.push(stamp({ ...tree, order }, now));
      }
    });
    if (updates.length) await this.saveMany(updates);
  }

  async create(name: string, accent: AccentToken): Promise<Tree> {
    return this.forestMutations.createTree(name, accent);
  }

  async rename(tree: Tree, name: string): Promise<void> {
    await this.save({ ...tree, name });
  }

  async setAccent(tree: Tree, accent: AccentToken): Promise<void> {
    await this.save({ ...tree, accent });
  }

  async setCurrentNode(tree: Tree, nodeId: string | null): Promise<void> {
    await this.save({ ...tree, currentNodeId: nodeId });
  }

  async archive(tree: Tree): Promise<void> {
    await this.save({ ...tree, archivedAt: Date.now() });
  }

  async restore(tree: Tree): Promise<void> {
    const current = this.byId().get(tree.id) ?? tree;
    if (!current.archivedAt) return;
    if (this.usesLocalForestMutations()) {
      this.forestMutations.assertRestoreTree(current.id);
    }
    await this.save({ ...current, archivedAt: null });
  }
}
