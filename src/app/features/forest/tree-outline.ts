import {
  Component, ElementRef, afterNextRender, computed, effect, inject, input, output, signal,
  untracked, viewChild,
} from '@angular/core';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { LIGHT_ICONS, NodePriority, Tree, TreeNode, lightRank } from '../../core/db/schema';
import { ritualKind } from '../../core/harvest';
import { SpiralGlyph } from './spiral';
import { HeartwoodGlyph } from './heartwood';

interface OutlineRow {
  node: TreeNode;
  depth: number;
  /** 1-based position when the parent's pasitos are an ordered path. */
  index: number | null;
  hasKids: boolean;
  isCollapsed: boolean;
  /** Descendants sleeping inside a collapsed row — the little (N) chip. */
  hiddenCount: number;
}

/** Trees larger than this open with their sub-branches folded. */
const AUTO_COLLAPSE_AT = 12;

/**
 * The little table of branches ("tablita"): an indented outline of the whole
 * tree, floating beside the canvas. One tap LOCATES a branch on the map
 * (focus + pan — browsing never opens sheets); tapping the same row again
 * opens its sheet. Rows with children carry a ▸/▾ triangle; big trees open
 * with depth-1 parents collapsed so the list never greets you long.
 */
@Component({
  selector: 'app-tree-outline',
  imports: [SpiralGlyph, HeartwoodGlyph],
  template: `
    <div class="head">
      <h2 #heading id="tree-branch-outline-title" tabindex="-1">{{ i18n.t().tree.outlineTitle }}</h2>
      @if (editable()) {
        <button
          type="button"
          class="btn btn-ghost lens"
          [class.lens-on]="lightLens()"
          (click)="lightLens.set(!lightLens())"
          [attr.aria-pressed]="lightLens()"
          [attr.aria-label]="i18n.t().tree.lightLens"
          [title]="i18n.t().tree.lightLens"
        >☀️</button>
      }
      <button
        type="button"
        class="btn btn-ghost close"
        (click)="closed.emit()"
        [attr.aria-label]="i18n.t().common.close"
      >✕</button>
    </div>
    <p class="outline-hint">{{ lightLens() ? i18n.t().tree.lightLensHint : i18n.t().tree.outlineHint }}</p>
    <ul>
      @for (row of rows(); track row.node.id) {
        <li class="line" [style.padding-left.px]="4 + row.depth * 14">
          @if (row.hasKids) {
            <button
              type="button"
              class="tri"
              (click)="toggle(row.node)"
              [attr.aria-expanded]="!row.isCollapsed"
              [attr.aria-label]="i18n.fill(
                row.isCollapsed ? i18n.t().tree.outlineExpand : i18n.t().tree.outlineCollapse,
                { title: row.node.title }
              )"
            >{{ row.isCollapsed ? '▸' : '▾' }}</button>
          } @else {
            <span class="tri spacer" aria-hidden="true">•</span>
          }
<!-- «El corazón del árbol» (0.0.112): the heart row reads as a tappable
     HEADING (🌳, no status-dot noise, no light button) — the tablita is a
     map, so locating/opening still works. Legacy extra roots stay normal. -->
          <button
            #branchButton
            type="button"
            class="row"
            [class.active]="focusedId() === row.node.id"
            [class.heart]="isHeart(row.node)"
            [attr.aria-current]="tree().currentNodeId === row.node.id ? 'location' : null"
            (click)="onRow(row, branchButton)"
          >
            @if (isHeart(row.node)) {
              <svg class="heart-mark" viewBox="-14 -14 28 28" aria-hidden="true">
                <g appHeartwood [tint]="'var(--accent-' + tree().accent + ')'" [scale]="0.95" />
              </svg>
            } @else {
              <span class="status-dot" [class]="'status-dot ' + row.node.status"></span>
            }
            @if (row.index !== null) {
              <span class="idx">{{ row.index }}.</span>
            }
            <span class="name" [class.done]="!isHeart(row.node) && row.node.status === 'achieved'">{{ row.node.title }}</span>
            @if (isRitual(row.node)) {
              <svg class="spiral-mark" viewBox="-14 -14 28 28" aria-hidden="true">
                <g appSpiral [animated]="false" [scale]="0.9" />
              </svg>
            }
            @if (isSunlit(row.node)) {
              <span class="sun-badge" aria-hidden="true">☀️</span>
            }
            @if (row.isCollapsed && row.hiddenCount) {
              <span class="hidden-count">({{ row.hiddenCount }})</span>
            }
            @if (tree().currentNodeId === row.node.id) {
              <span class="pin" aria-hidden="true">📍</span>
            }
          </button>
          @if (lightLens() && isLive(row.node) && !isHeart(row.node)) {
            <button
              type="button"
              class="light-cycle"
              (click)="cycleLight(row.node)"
              [attr.aria-label]="i18n.fill(i18n.t().tree.lightCycle, { title: row.node.title })"
              [title]="i18n.t().light[lightOf(row.node)]"
            >{{ lightIcon(row.node) }}</button>
          }
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.4rem;

      h2 {
        font-size: 0.95rem;
        margin: 0;
      }

      .close {
        min-height: 36px;
        min-width: 36px;
        padding: 0.2rem;
      }
    }

    .outline-hint {
      margin: 0.1rem 0 0.5rem;
      font-size: 0.76rem;
      color: var(--text-faint);
    }

    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      min-height: 0;
    }

    .line {
      display: flex;
      align-items: center;
    }

    .tri {
      flex: none;
      width: 24px;
      min-height: 34px;
      border: none;
      background: none;
      color: var(--text-faint);
      font-size: 0.72rem;
      cursor: pointer;
      border-radius: 6px;

      &:hover:not(.spacer) {
        background: color-mix(in srgb, var(--primary) 10%, transparent);
        color: var(--text);
      }

      &.spacer {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.45;
        cursor: default;
      }
    }

    .row {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      flex: 1;
      min-width: 0;
      border: none;
      background: none;
      color: var(--text);
      font: inherit;
      font-size: 0.88rem;
      text-align: left;
      padding: 0.42rem 0.5rem 0.42rem 0.2rem;
      border-radius: 8px;
      cursor: pointer;

      &:hover {
        background: color-mix(in srgb, var(--primary) 8%, transparent);
      }

      &.active {
        background: color-mix(in srgb, var(--primary) 13%, transparent);
        font-weight: 700;
      }

      .idx {
        color: var(--text-faint);
        font-size: 0.78rem;
        font-weight: 700;
      }

      .name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;

        &.done {
          color: var(--text-faint);
          text-decoration: line-through;
          text-decoration-color: var(--status-achieved);
        }
      }

      .hidden-count {
        color: var(--text-faint);
        font-size: 0.74rem;
      }

      /* «El corazón del árbol» (0.0.112) — a tappable heading, not a task */
      &.heart .name {
        font-weight: 700;
      }

      .heart-mark {
        flex: none;
        width: 17px;
        height: 17px;
      }

      .sun-badge {
        font-size: 0.72rem;
      }

      /* the still mini-spiral: this row is a living ritual (0.0.104) */
      .spiral-mark {
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
      }

      .pin {
        font-size: 0.8rem;
      }
    }

    .head .lens {
      min-height: 36px;
      min-width: 36px;
      padding: 0.2rem;
      opacity: 0.55;

      &.lens-on {
        opacity: 1;
        background: color-mix(in srgb, var(--status-branched) 18%, transparent);
        border-radius: 8px;
      }
    }

    .light-cycle {
      flex: none;
      min-width: 34px;
      min-height: 34px;
      border: none;
      background: none;
      font-size: 0.85rem;
      cursor: pointer;
      border-radius: 8px;

      &:hover {
        background: color-mix(in srgb, var(--primary) 10%, transparent);
      }
    }
  `,
})
export class TreeOutline {
  readonly tree = input.required<Tree>();
  readonly focusedId = input<string | null>(null);
  /** Look-only visits get no light controls (the visit funnel blocks writes anyway). */
  readonly editable = input<boolean>(true);
  readonly locate = output<TreeNode>();
  readonly open = output<TreeNode>();
  readonly closed = output<void>();

  protected readonly i18n = inject(I18nService);
  private readonly nodes = inject(NodesRepo);
  private readonly heading = viewChild.required<ElementRef<HTMLHeadingElement>>('heading');
  private readonly lastTap = signal<string | null>(null);

  /** «Ver por luz» — session-scoped like the folds: a lens, not state. It
   *  re-sorts THIS LIST only; the tree's shape never moves (priority never
   *  writes `order`). */
  protected readonly lightLens = signal(false);

  /** Folded rows. Session-scoped on purpose — the tablita is a lens, not state. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  private seededFor: string | null = null;

  constructor() {
    afterNextRender(() => this.heading().nativeElement.focus({ preventScroll: true }));

    // The "second tap opens" memory only means something while the row is
    // still the focused one — after focusing elsewhere (a canvas tap), a
    // return tap minutes later should LOCATE again, not surprise-open.
    effect(() => {
      const focused = this.focusedId();
      if (this.lastTap() && this.lastTap() !== focused) this.lastTap.set(null);
    });

    // Big trees open folded to their main branches — once per tree visit.
    effect(() => {
      const treeId = this.tree().id;
      if (this.seededFor === treeId) return;
      this.seededFor = treeId;
      untracked(() => {
        const seed = new Set<string>();
        const total = (this.nodes.byTree().get(treeId) ?? []).length;
        if (total > AUTO_COLLAPSE_AT) {
          for (const root of this.nodes.rootsOf(treeId)) {
            for (const child of this.nodes.childrenOf(root)) {
              if (this.nodes.childrenOf(child).length) seed.add(child.id);
            }
          }
        }
        this.collapsed.set(seed);
      });
    });
  }

  protected readonly rows = computed<OutlineRow[]>(() => {
    const folded = this.collapsed();
    const out: OutlineRow[] = [];
    const countDesc = (node: TreeNode): number => {
      let count = 0;
      const queue = [...this.nodes.childrenOf(node)];
      while (queue.length) {
        const n = queue.pop()!;
        count++;
        queue.push(...this.nodes.childrenOf(n));
      }
      return count;
    };
    const walk = (node: TreeNode, depth: number, index: number | null) => {
      const kids = this.nodes.childrenOf(node);
      const isCollapsed = folded.has(node.id) && kids.length > 0;
      out.push({
        node,
        depth,
        index,
        hasKids: kids.length > 0,
        isCollapsed,
        hiddenCount: isCollapsed ? countDesc(node) : 0,
      });
      if (isCollapsed) return;
      const ordered = node.flow === 'steps';
      // The light lens re-sorts sibling groups (sun → steady → shade), but
      // NEVER inside an ordered path — 1./2./3. must not lie.
      const shown =
        this.lightLens() && !ordered
          ? [...kids].sort((a, b) => lightRank(a) - lightRank(b) || a.order - b.order)
          : kids;
      shown.forEach((child, i) => walk(child, depth + 1, ordered ? i + 1 : null));
    };
    for (const root of this.nodes.rootsOf(this.tree().id)) walk(root, 0, null);
    return out;
  });

  // ── «la luz» helpers ───────────────────────────────────────────────────

  /** The tree's heart (first visible root) reads as a heading, not a task. */
  protected isHeart(node: TreeNode): boolean {
    return this.nodes.heartOf(this.tree().id)?.id === node.id;
  }

  protected isLive(node: TreeNode): boolean {
    return node.status === 'seed' || node.status === 'growing';
  }

  /** «La espiral» (0.0.104): this row is a ritual (leaf or sendero parent). */
  protected isRitual(node: TreeNode): boolean {
    return ritualKind(node) !== null;
  }

  /** The badge honors the ask: sun shows, shade deliberately doesn't (it
   *  asked for less attention — the honest response is to give it less). */
  protected isSunlit(node: TreeNode): boolean {
    return node.priority === 'sunlit' && this.isLive(node);
  }

  protected lightOf(node: TreeNode): 'sunlit' | 'steady' | 'shade' {
    const p = node.priority;
    return p === 'sunlit' || p === 'shade' ? p : 'steady';
  }

  protected lightIcon(node: TreeNode): string {
    // Shared vocabulary (0.0.115 M7): this hand-copied map still said 🌳
    // for shade — the forest's glyph on a parasol (emoji-law violation).
    return LIGHT_ICONS[this.lightOf(node)];
  }

  /** ritmo → sol → sombra → ritmo. Writes through NodesRepo.update — on a
   *  guardian visit that's the shadowed repo, i.e. the kid's cloud forest. */
  protected async cycleLight(node: TreeNode): Promise<void> {
    const next: Record<string, NodePriority | null> = {
      steady: 'sunlit',
      sunlit: 'shade',
      shade: null,
    };
    await this.nodes.update(node, { priority: next[this.lightOf(node)] });
  }

  protected toggle(node: TreeNode): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  }

  /** First tap locates; a second tap on the same row opens its sheet. */
  protected onRow(row: OutlineRow, button: HTMLButtonElement): void {
    if (this.lastTap() === row.node.id) {
      button.focus({ preventScroll: true });
      this.open.emit(row.node);
    } else {
      this.lastTap.set(row.node.id);
      this.locate.emit(row.node);
    }
  }
}
