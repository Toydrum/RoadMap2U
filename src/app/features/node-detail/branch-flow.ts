import { Component, computed, inject, input, output, signal } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { TreeNode } from '../../core/db/schema';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { forestQuotaMessage } from '../forest/forest-quota-feedback';

/** Cap on alternative paths — visible in the UI as a counter, never silent. */
const MAX_PATHS = 5;

/** Cap on the user's own quick chips — a hand, not a hoard. */
const MAX_CHIPS = 6;

/**
 * The transformation moment: a goal whose moment passed becomes a branch
 * point. Up to five alternative paths; one is enough. The original stays
 * in the tree, honored as part of the story.
 */
@Component({
  selector: 'app-branch-flow',
  imports: [SheetDirective],
  templateUrl: './branch-flow.html',
  styleUrl: './branch-flow.scss',
})
export class BranchFlow {
  protected readonly inputValue = inputValue;
  readonly node = input.required<TreeNode>();
  readonly closed = output<void>();

  protected readonly i18n = inject(I18nService);
  private readonly nodes = inject(NodesRepo);
  private readonly trees = inject(TreesRepo);
  private readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);

  /** The user's own quick paths — saved once, reused on every ramificación. */
  protected readonly customChips = computed(() => this.settings.settings().customBranchChips);

  protected readonly alternatives = signal<string[]>(['']);
  protected readonly maxPaths = MAX_PATHS;

  /** "n de 5" — the cap speaks instead of silently hiding the button. */
  protected altCountLabel(): string {
    return this.i18n.fill(this.i18n.t().branchFlow.altCount, {
      count: this.alternatives().length,
      max: MAX_PATHS,
    });
  }

  /** The five honest ways a goal gets stuck — each prefills an editable path. */
  protected readonly suggestionKeys = ['smaller', 'otherTime', 'otherWay', 'together', 'rest'] as const;

  protected suggestionLabel(key: (typeof this.suggestionKeys)[number]): string {
    return this.i18n.t().branchFlow.suggestions[key];
  }

  /** Tap a chip → fill the first empty slot (or add one) with an editable template. */
  protected applySuggestion(key: (typeof this.suggestionKeys)[number]): void {
    const s = this.i18n.t().branchFlow.suggestions;
    const templates = {
      smaller: s.smallerTemplate,
      otherTime: s.otherTimeTemplate,
      otherWay: s.otherWayTemplate,
      together: s.togetherTemplate,
      rest: s.restTemplate,
    };
    const template = templates[key];
    const title = this.node().title;
    const shortTitle = title.length > 34 ? title.slice(0, 33) + '…' : title;
    const text = this.i18n.fill(template, { title: shortTitle });

    this.alternatives.update((alts) => {
      const emptyIdx = alts.findIndex((a) => !a.trim());
      if (emptyIdx !== -1) return alts.map((a, i) => (i === emptyIdx ? text : a));
      if (alts.length < MAX_PATHS) return [...alts, text];
      return alts;
    });
  }

  protected setAlt(index: number, value: string): void {
    this.alternatives.update((alts) => alts.map((a, i) => (i === index ? value : a)));
  }

  /** A custom chip fills the first empty slot verbatim (the user's words). */
  protected applyCustom(text: string): void {
    this.alternatives.update((alts) => {
      const emptyIdx = alts.findIndex((a) => !a.trim());
      if (emptyIdx !== -1) return alts.map((a, i) => (i === emptyIdx ? text : a));
      if (alts.length < MAX_PATHS) return [...alts, text];
      return alts;
    });
  }

  /** Can this typed path still be kept as a chip? */
  protected canSaveChip(text: string): boolean {
    const t = text.trim();
    return t.length >= 3 && !this.customChips().includes(t) && this.customChips().length < MAX_CHIPS;
  }

  protected async saveChip(text: string): Promise<void> {
    const t = text.trim();
    if (!this.canSaveChip(t)) return;
    await this.settings.patch({ customBranchChips: [...this.customChips(), t] });
  }

  protected async removeChip(text: string): Promise<void> {
    await this.settings.patch({
      customBranchChips: this.customChips().filter((c) => c !== text),
    });
  }

  protected addAlt(): void {
    if (this.alternatives().length < MAX_PATHS) this.alternatives.update((alts) => [...alts, '']);
  }

  protected valid(): boolean {
    return this.alternatives().some((a) => a.trim());
  }

  protected async confirm(): Promise<void> {
    const drafts = this.alternatives()
      .map((a) => a.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
    if (!drafts.length) return;

    // Held for the undo window: the exact pre-branch record and pin.
    const before = this.node();
    const tree = this.trees.byId().get(before.treeId);
    const prevCurrent = tree?.currentNodeId ?? null;

    let children: TreeNode[];
    try {
      children = await this.nodes.branch(before, drafts);
    } catch (error) {
      const message = forestQuotaMessage(this.i18n, error);
      if (!message) throw error;
      this.toast.show({ message });
      return;
    }

    // "You are here" moves to the first new path.
    if (tree && children.length) await this.trees.setCurrentNode(tree, children[0].id);

    this.toast.show(
      {
        message: this.i18n.t().branchFlow.celebrate,
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.undoBranch(before, prevCurrent),
      },
      UNDO_MS,
    );
    this.closed.emit();
  }

  /** Seconds-old undo restores the EXACT prior record — including a passed
   *  targetDate, whose review conversation honestly re-offers itself. */
  private async undoBranch(before: TreeNode, prevCurrent: string | null): Promise<void> {
    const parent = this.nodes.byId().get(before.id);
    if (!parent || parent.status !== 'branched') return;
    const removed = await this.nodes.revertBranch(parent, {
      status: before.status,
      targetDate: before.targetDate,
    });
    const tree = this.trees.byId().get(parent.treeId);
    if (tree && removed.some((c) => c.id === tree.currentNodeId)) {
      await this.trees.setCurrentNode(tree, prevCurrent);
    }
  }
}
