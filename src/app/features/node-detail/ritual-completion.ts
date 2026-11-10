import { Injectable, inject } from '@angular/core';
import { cadenceOf, isScheduledOn } from '../../core/cadence';
import { TreeNode } from '../../core/db/schema';
import { occurrenceRitual } from '../../core/harvest';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { today } from '../../core/time';
import { BloomBurstService } from '../../shared/ui/bloom-burst';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { flowerFor } from '../forest/flora';

export function occurrenceAvailable(node: TreeNode, ritual: TreeNode, day: string): boolean {
  const cadence = cadenceOf(ritual);
  return !!cadence && !ritual.archivedAt && !ritual.deletedAt &&
    ritual.status !== 'resting' && (ritual.id === node.id || ritual.status !== 'achieved') &&
    isScheduledOn(cadence, day);
}

/** The Almanaque and branch sheet complete the same recurring occurrence. */
@Injectable({ providedIn: 'root' })
export class RitualCompletion {
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);
  private readonly burst = inject(BloomBurstService);
  private readonly pending = new Set<string>();

  async complete(nodes: NodesRepo, trees: TreesRepo, id: string, anchor: Element | null): Promise<void> {
    if (this.pending.has(id)) return;
    const node = nodes.byId().get(id);
    if (!node || node.deletedAt || node.archivedAt || (node.status !== 'seed' && node.status !== 'growing')) return;
    const tree = trees.byId().get(node.treeId);
    if (!tree || tree.deletedAt || tree.archivedAt) return;
    const ritual = occurrenceRitual(node, nodes.byId());
    if (!ritual || !occurrenceAvailable(node, ritual, today())) return;

    this.pending.add(id);
    try {
      const bloomed = await nodes.setStatus(node, 'achieved');
      this.burst.burstAt(anchor, flowerFor(tree.accent, tree.id));
      this.toast.show({
        message: this.i18n.fill(this.i18n.t().almanaque.stoneBloomed, { title: bloomed.title }),
        actionLabel: this.i18n.t().common.undo,
        action: () => {
          const live = nodes.byId().get(id);
          const currentTree = trees.byId().get(tree.id);
          if (!live || live.deletedAt || live.archivedAt || live.status !== 'achieved' ||
              live.achievedAt !== bloomed.achievedAt || !currentTree || currentTree.deletedAt || currentTree.archivedAt) return;
          void nodes.setStatus(live, node.status);
        },
      }, UNDO_MS);
    } finally {
      this.pending.delete(id);
    }
  }
}
