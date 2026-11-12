import { afterNextRender, Component, inject, Injector, input, signal } from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import type { SyncConflict, SyncConflictRecordRef } from '../../core/sync/sync-conflict.store';
import { SyncService } from '../../core/sync/sync.service';
import { ToastService } from '../../shared/ui/toast.service';

@Component({
  selector: 'app-sync-conflict-review',
  template: `
    @let conflicts = sync.deviceConflicts();
    @if (conflicts.length) {
        @let copy = i18n.t().nube.conflicts;
        <section aria-labelledby="sync-conflicts-heading">
          <h3 id="sync-conflicts-heading">{{ copy.title }}</h3>
          <ul class="conflicts">
            @for (conflict of conflicts; track conflict.id) {
              <li class="conflict">
                <p>{{ i18n.t().familia.errors[conflict.code] }}</p>
                @if (conflict.state === 'local-only') {
                  <p>{{ copy.keptLocal }}</p>
                }
                <ul class="records">
                  @for (ref of conflict.recordRefs; track ref.store + ':' + ref.id) {
                    <li>{{ recordLabel(ref) }}</li>
                  }
                </ul>
                <div class="actions">
                  @if (conflict.actions.includes('retry')) {
                    <button
                      #retryButton
                      type="button"
                      class="btn btn-soft"
                      [attr.aria-disabled]="busy() ? 'true' : null"
                      (click)="resolve(conflict, 'retry', retryButton)"
                    >{{ copy.retry }}</button>
                  }
                  @if (conflict.state === 'pending' && conflict.actions.includes('local-only')) {
                    <button
                      #localButton
                      type="button"
                      class="btn btn-ghost"
                      [attr.aria-disabled]="busy() ? 'true' : null"
                      (click)="resolve(conflict, 'local-only', localButton)"
                    >{{ copy.keepLocal }}</button>
                  }
                </div>
              </li>
            }
          </ul>
        </section>
    }
  `,
  styles: `
    section { margin-top: 1.25rem; }
    h3, p { margin: 0; }
    .conflicts { display: grid; gap: .9rem; padding: 0; list-style: none; }
    .conflict { display: grid; gap: .5rem; }
    .records { padding-inline-start: 1.4rem; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: .45rem; }
    .actions button { min-height: 44px; }
    button[aria-disabled="true"] { opacity: .65; }
  `,
})
export class SyncConflictReview {
  readonly fallbackFocus = input.required<HTMLElement>();
  protected readonly i18n = inject(I18nService);
  protected readonly sync = inject(SyncService);
  private readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly resolving = signal(false);

  protected busy(): boolean {
    return this.resolving() || this.sync.phase() === 'syncing';
  }

  protected recordLabel(ref: SyncConflictRecordRef): string {
    const copy = this.i18n.t().nube.conflicts;
    if (ref.store === 'trees') return this.trees.byId().get(ref.id)?.name || copy.records.trees;
    if (ref.store === 'nodes') {
      const node = this.nodes.byId().get(ref.id);
      if (!node?.title) return copy.records.nodes;
      const tree = this.trees.byId().get(node.treeId);
      return tree?.name
        ? this.i18n.fill(copy.branchInTree, { branch: node.title, tree: tree.name })
        : node.title;
    }
    return copy.records[ref.store];
  }

  protected async resolve(
    conflict: SyncConflict,
    resolution: 'retry' | 'local-only',
    trigger: HTMLButtonElement,
  ): Promise<void> {
    if (this.busy()) return;
    const nextFocus = trigger.closest('.actions')?.querySelector('button');
    this.resolving.set(true);
    try {
      const resolved = await this.sync.resolveConflict(conflict.id, resolution);
      const copy = this.i18n.t().nube.conflicts;
      this.toast.show({ message: !resolved ? copy.actionUnavailable
        : resolution === 'retry' ? copy.retryQueued : copy.keptLocal });
    } catch {
      this.toast.show({ message: this.i18n.t().nube.conflicts.actionUnavailable });
    } finally {
      this.resolving.set(false);
      afterNextRender(() => {
        if (!trigger.isConnected && trigger.ownerDocument.activeElement === trigger.ownerDocument.body) {
          (nextFocus?.isConnected ? nextFocus : this.fallbackFocus()).focus();
        }
      }, { injector: this.injector });
    }
  }
}
