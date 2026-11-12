import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { NodeStatus, Tree, TreeNode } from '../../core/db/schema';
import { bearsNoFruit, ritualKind } from '../../core/harvest';
import { SpiralGlyph } from './spiral';
import { HeartwoodGlyph } from './heartwood';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { I18nService } from '../../core/i18n/i18n.service';
import { MotionService } from '../../core/motion.service';
import { FocusSessionService } from '../../core/focus-session.service';
import { PerchAnchorService } from '../../core/perch-anchor.service';
import { PerchBody } from '../../shared/ui/perch-body';
import {
  LayoutPoint,
  branchRibbon,
  hash,
  layoutTree,
} from './tree-layout';
import { FlowerSpec, FruitSpec, flowerFor, fruitFor } from './flora';
import { TreeForm, formFor } from './tree-forms';
import {
  LeafDecoration,
  LimbPlan,
  PadDecoration,
  groundDecorFor,
  leavesFor,
  padsFor,
  planLimbs,
  trunkFlarePath,
  trunkPath,
  woodFill,
  woodFor,
} from './tree-silhouette';
import { FlowerGlyph } from './flower';
import { FruitGlyph } from './fruit';
import {
  LABEL_FONT_SIZE,
  LabelBlock,
  MeasureLabel,
  labelInputsFrom,
  packLabels,
} from './tree-labels';

/** One falling fruit — «la cosecha»'s one-shot bloom celebration. */
interface FruitDrop {
  key: string;
  x: number;
  y: number;
  /** World-units distance from the bloomed tip down to the ground rest. */
  fall: number;
  /** Deterministic sideways arc (hash of the node id — rule 4). */
  drift: number;
  spec: FruitSpec;
}

interface EdgeView {
  id: string;
  d: string;
  fill: string;
  isNew: boolean;
  leaves: LeafDecoration[];
  /** Foliage pads clustering at the tip — the crown's soft volume. */
  pads: PadDecoration[];
  /** Bark grain: the limb's center line, stroked dashed and faint. */
  grain: string;
  grainWidth: number;
  grainOffset: number;
}



/**
 * The living map: an SVG tree that actually looks like one — thick tapering
 * limbs, procedural leaves, flowers on achieved goals, ground under the roots.
 * Pointer pan/zoom (1 finger pan, 2 finger pinch, ctrl-wheel zoom), roving
 * tabindex keyboard navigation, a one-time "grow" animation for newborn
 * branches, and a floating "+" bud on the focused node to plant right there.
 */
@Component({
  selector: 'app-tree-canvas',
  imports: [FlowerGlyph, FruitGlyph, SpiralGlyph, HeartwoodGlyph, PerchBody, RouterLink],
  templateUrl: './tree-canvas.html',
  styleUrl: './tree-canvas.scss',
  // Closes the little note letter when tapping anywhere else (never preventDefault).
  host: { '(document:pointerdown)': 'onDocPointerDown($event)' },
})
export class TreeCanvas {
  readonly tree = input.required<Tree>();
  readonly nodeOpened = output<TreeNode>();
  readonly plantRequested = output<TreeNode>();

  protected readonly nodes = inject(NodesRepo);
  protected readonly i18n = inject(I18nService);
  protected readonly motion = inject(MotionService);
  protected readonly Math = Math;
  protected readonly labelFontSize = LABEL_FONT_SIZE;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly svgRef = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  private readonly focusReadout = viewChild.required<ElementRef<HTMLElement>>('focusReadout');
  private readonly labelMeasure = signal<MeasureLabel | undefined>(undefined);

  /** Pan/zoom state. */
  protected readonly tx = signal(0);
  protected readonly ty = signal(0);
  protected readonly k = signal(1);

  /** Paper leaf under the pointer — a little letter opens beside it. */
  protected readonly hoverNote = signal<{ node: TreeNode; wx: number; wy: number } | null>(null);

  /** The letter follows its mark through pan and zoom. */
  protected readonly letterPos = computed(() => {
    const hover = this.hoverNote();
    if (!hover) return null;
    return { x: this.tx() + hover.wx * this.k(), y: this.ty() + hover.wy * this.k() };
  });

  protected showLetter(point: LayoutPoint): void {
    this.hoverNote.set({ node: point.node, wx: point.x + 18, wy: point.y - 24 });
  }

  protected hideLetter(): void {
    this.hoverNote.set(null);
  }

  /* ------------------------------------ the parakeet perches on the ramita */

  protected readonly focus = inject(FocusSessionService);
  private readonly perchAnchor = inject(PerchAnchorService);

  /** The session's node, only when it lives in THIS tree and is visible.
   *  On visits the injected repo is the other person's — the lookup misses
   *  and the parakeet correctly stays off someone else's forest. */
  private readonly sessionNode = computed(() => {
    const id = this.focus.active()?.nodeId;
    if (!id) return null;
    const node = this.nodes.byId().get(id);
    return node && !node.archivedAt && !node.deletedAt && node.treeId === this.tree().id
      ? node
      : null;
  });

  /** Screen position of the perch — the note-letter pattern: constant size,
   *  rides the branch through pan and zoom. */
  protected readonly perchPoint = computed(() => {
    const node = this.sessionNode();
    if (!node) return null;
    const p = this.layout().byId.get(node.id);
    if (!p) return null;
    return { x: this.tx() + p.x * this.k(), y: this.ty() + p.y * this.k() };
  });


  /** Mouse hovers; touch taps to toggle (hover events fight the tap there). */
  protected onMarkEnter(ev: PointerEvent, point: LayoutPoint): void {
    if (ev.pointerType === 'mouse') this.showLetter(point);
  }

  protected onMarkLeave(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse') this.hideLetter();
  }

  protected toggleLetter(point: LayoutPoint): void {
    if (this.hoverNote()?.node.id === point.node.id) {
      this.hideLetter();
    } else {
      this.showLetter(point);
    }
  }

  /** Tapping anywhere outside the mark/letter puts the letter away. */
  protected onDocPointerDown(ev: PointerEvent): void {
    if (!this.hoverNote()) return;
    if ((ev.target as Element).closest?.('.note-mark, .note-letter')) return;
    this.hideLetter();
  }

  /** Roving tabindex focus (also drives the "+" bud). Public: the outline
   *  rail highlights the focused row and calls focusNode() to locate. */
  readonly focusedId = signal<string | null>(null);

  /** Nodes created this session get the grow animation exactly once. */
  private readonly bornThisSession = new Set<string>();
  private knownIds: Set<string> | null = null;
  private knownTreeId: string | null = null;

  /** «La cosecha» (0.0.88): last seen status per node — the diff that plays
   *  the fruit drop on a transition INTO achieved, whoever caused it
   *  (bloomStep, the status picker, even a cross-tab write). */
  private knownStatus: Map<string, NodeStatus> | null = null;
  protected readonly fruitDrops = signal<FruitDrop[]>([]);

  protected readonly layout = computed(() => {
    const tree = this.tree();
    const roots = this.nodes.rootsOf(tree.id);
    return layoutTree(roots, (n) => this.nodes.childrenOf(n));
  });

  /** This tree's flower species (color family from its accent, cousin
   *  silhouette from its id — same accent, sibling blooms). */
  protected readonly species = computed<FlowerSpec>(() =>
    flowerFor(this.tree().accent, this.tree().id),
  );

  /** This tree's silhouette personality — "cada árbol su porte": the accent
   *  picks the family, the id makes it an individual (form-dial jitter). */
  protected readonly form = computed<TreeForm>(() => formFor(this.tree().accent, this.tree().id));

  protected readonly roots = computed(() => this.layout().points.filter((p) => p.parent === null));

  /** Ground line sits a bit under the deepest root. */
  protected readonly groundY = computed(() => {
    const roots = this.roots();
    if (!roots.length) return 80;
    return Math.max(...roots.map((r) => r.y)) + 64;
  });

  /** World-space life around the base (pure: tree-silhouette.ts). */
  protected readonly groundDecor = computed(() =>
    groundDecorFor(this.layout(), this.tree().id, this.groundY()),
  );

  /** The silhouette brain lives in tree-silhouette.ts (pure, vitest-able);
   *  the tip test is the one live coupling — it needs the repo. */
  private readonly limbPlan = computed<Map<string, LimbPlan>>(() =>
    planLimbs(
      this.layout().points,
      this.form(),
      this.wood(),
      this.tree().id,
      (p) => this.nodes.childrenOf(p.node).length === 0 && !p.chainNextId,
    ),
  );

  protected readonly edges = computed<EdgeView[]>(() =>
    this.layout()
      .points.filter((p) => p.parent !== null)
      .map((p) => {
        const plan = this.limbPlan().get(p.node.id)!;
        return {
          id: p.node.id,
          d: branchRibbon(plan.start, p, plan.geom, plan.w0, plan.w1),
          fill: woodFill(p, this.wood()),
          isNew: this.bornThisSession.has(p.node.id),
          leaves: leavesFor(p, plan.start, plan.geom, this.form()),
          pads: padsFor(p, plan.start, plan.geom, plan.isLeaf, this.form()),
          grain: plan.geom.d,
          grainWidth: Math.max(1.1, plan.w1 * 0.35),
          grainOffset: hash(p.node.id + ':grain') % 16,
        };
      }),
  );

  /** This tree's wood personality (pure: tree-silhouette.ts). */
  protected readonly wood = computed(() => woodFor(this.tree().id, this.form()));

  protected trunkPath(root: LayoutPoint): string {
    return trunkPath(root, this.groundY(), this.wood(), this.form(), this.layout().points.length);
  }

  protected trunkFlarePath(root: LayoutPoint): string {
    return trunkFlarePath(root, this.groundY(), this.wood(), this.form(), this.layout().points.length);
  }

  /** The trunk wears the tree's own bark family (deepest mix) — a fixed
   *  --rm-bark fill used to seam against the per-tree limb colors. */
  protected trunkFill(root: LayoutPoint): string {
    return woodFill(root, this.wood());
  }

  /** One-shot fruit drop at a just-bloomed tip; DOM-removed at 2600ms (the
   *  highlight-timeout precedent). Re-bloom replaces its own drop only —
   *  nothing else moves (rule 4). */
  private dropFruit(p: LayoutPoint): void {
    const drop: FruitDrop = {
      key: p.node.id,
      x: p.x,
      y: p.y,
      fall: Math.max(24, this.groundY() - p.y - 8),
      drift: (hash(p.node.id + ':caida') % 17) - 8,
      spec: fruitFor(this.tree().accent, this.tree().id),
    };
    this.fruitDrops.update((list) => [...list.filter((d) => d.key !== drop.key), drop]);
    setTimeout(() => {
      this.fruitDrops.update((list) => list.filter((d) => d !== drop));
    }, 2600);
  }

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { dist: number; k: number; midX: number; midY: number; tx: number; ty: number } | null = null;
  private panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  private movedSinceDown = false;

  constructor() {
    // Track newborn nodes for the grow animation; pan the newest into view
    // so planting can never grow the tree off-screen unnoticed.
    effect(() => {
      // A tree SWITCH within a reused component (adjacent history entries)
      // must reset the newborn tracker — diffing tree A's ids against tree
      // B's marked B's every node "born" and played the grow animation on
      // the whole destination tree.
      const treeId = this.tree().id;
      if (treeId !== this.knownTreeId) {
        this.knownTreeId = treeId;
        this.knownIds = null;
        this.bornThisSession.clear();
        this.knownStatus = null;
      }
      const ids = new Set(this.layout().points.map((p) => p.node.id));
      if (this.knownIds) {
        let lastNew: LayoutPoint | null = null;
        for (const id of ids) {
          if (!this.knownIds.has(id)) {
            this.bornThisSession.add(id);
            lastNew = this.layout().byId.get(id) ?? null;
          }
        }
        if (lastNew) {
          const p = lastNew;
          queueMicrotask(() => this.panIntoView(p));
        }
      }
      this.knownIds = ids;

      // «La cosecha»: a branch that just BLOOMED drops its fruit — one
      // modest drop, identical for every bloom, whoever flipped the status
      // (bloomStep, the picker, a cross-tab write). Sendero pasitos bear no
      // fruit (core/harvest.ts — one law with the jar), and only a
      // transition INTO achieved plays; reopening stays quiet.
      const statuses = new Map<string, NodeStatus>();
      for (const p of this.layout().points) statuses.set(p.node.id, p.node.status);
      if (this.knownStatus) {
        const bloomed: LayoutPoint[] = [];
        for (const p of this.layout().points) {
          const prev = this.knownStatus.get(p.node.id);
          if (!prev || prev === 'achieved' || p.node.status !== 'achieved') continue;
          if (bearsNoFruit(p.node, this.nodes.byId())) continue;
          bloomed.push(p);
        }
        if (bloomed.length) {
          queueMicrotask(() => bloomed.forEach((p) => this.dropFruit(p)));
        }
      }
      this.knownStatus = statuses;
    });

    // Frame ONCE per tree (id-keyed): renames and status flips must never
    // yank the camera around — that was a real pre-0.0.39 annoyance.
    effect(() => {
      const id = this.tree().id;
      if (!this.layout().points.length || id === this.lastFitId) return;
      this.lastFitId = id;
      queueMicrotask(() => this.fitTree());
    });

    // While the session's branch is on THIS canvas, the scene holds the
    // parakeet and the app shell's corner perch yields.
    effect(() => {
      if (this.perchPoint()) this.perchAnchor.claim('tree');
      else this.perchAnchor.release('tree');
    });
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.perchAnchor.release('tree'));
    afterNextRender(() => this.observeLabelFont(destroyRef));
  }

  private observeLabelFont(destroyRef: DestroyRef): void {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    context.textAlign = 'center';
    let family = '';
    const refresh = (force: boolean): void => {
      const next = getComputedStyle(this.host.nativeElement).getPropertyValue('--font-body').trim();
      if (!next || (!force && next === family)) return;
      family = next;
      const cache = new Map<string, ReturnType<MeasureLabel>>();
      this.labelMeasure.set((line, size) => {
        const key = size + ':' + line;
        const cached = cache.get(key);
        if (cached) return cached;
        context.font = `800 ${size}px ${next}`;
        const metrics = context.measureText(line);
        const result = {
          width: Math.max(metrics.width, 2 * metrics.actualBoundingBoxLeft, 2 * metrics.actualBoundingBoxRight),
          ascent: Math.max(metrics.actualBoundingBoxAscent, metrics.fontBoundingBoxAscent ?? size),
          descent: Math.max(metrics.actualBoundingBoxDescent, metrics.fontBoundingBoxDescent ?? size * 0.3),
        };
        if (cache.size >= 4096) cache.clear();
        cache.set(key, result);
        return result;
      });
    };
    const observer = new MutationObserver(() => refresh(false));
    observer.observe(document.documentElement, { attributeFilter: ['data-theme', 'class'] });
    const onFontsLoaded = (): void => refresh(true);
    document.fonts.addEventListener('loadingdone', onFontsLoaded);
    void document.fonts.ready.then(() => {
      if (!destroyRef.destroyed) onFontsLoaded();
    });
    refresh(false);
    destroyRef.onDestroy(() => {
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', onFontsLoaded);
    });
  }

  private lastFitId: string | null = null;

  /* ------------------------------------------------------------------ */
  /* View helpers                                                        */
  /* ------------------------------------------------------------------ */

  protected transform(): string {
    return `translate(${this.tx()} ${this.ty()}) scale(${this.k()})`;
  }

  protected statusColor(node: TreeNode): string {
    return `var(--status-${node.status})`;
  }

  /** «La espiral» (0.0.104): a ritual (lone leaf OR sendero parent) wears
   *  the spiral+star-dust glyph while pending — the SAME symbol walked in
   *  the almanaque. One predicate with the fruit law (harvest.ts). */
  /** «El corazón en el tronco» (0.0.114): the container heart wears its
   *  heartwood rings ON the tree — the same sign as its chip and the
   *  tablita heading. A BARE heart keeps ordinary glyphs (it is the goal
   *  itself), and an ACHIEVED heart blooms into the species flower (the
   *  whole-tree celebration outranks the rings). */
  protected isContainerHeart(node: TreeNode): boolean {
    return this.nodes.heartOf(node.treeId)?.id === node.id && this.nodes.childrenOf(node).length > 0;
  }

  protected isRitual(node: TreeNode): boolean {
    return ritualKind(node) !== null;
  }

  /** Cosmetic hover zone only — taps resolve via the canvas-level nearest
   *  pick, so this may never outgrow the slot spacing again (24 · 2 < 66). */
  protected hitRadius(): number {
    return Math.min(24, Math.max(16, 24 / this.k()));
  }

  /** The "+" bud keeps a finger-sized target even zoomed out: ~18 SCREEN px
   *  (the old world-space clamp shrank it to 8-10px at the zoom floors).
   *  World cap 34 keeps the disc clear of the node glyph 46px below. */
  protected budHitRadius(): number {
    return Math.min(34, 18 / this.k());
  }

  /** The bud floats above the node — except on an ordered-steps branch,
   *  where straight-up would land exactly on the first chain link (46px). */
  protected budTransform(point: LayoutPoint): string {
    const chainParent = point.node.flow === 'steps' && this.nodes.childrenOf(point.node).length > 0;
    return chainParent ? 'translate(32 -30)' : 'translate(0 -46)';
  }

  /** Per steps-branch: the earliest still-open step — it speaks its name. */
  private readonly nextStepIds = computed(() => {
    const out = new Set<string>();
    for (const p of this.layout().points) {
      if (p.node.flow !== 'steps') continue;
      const next = this.nodes
        .childrenOf(p.node)
        .find((c) => c.status === 'seed' || c.status === 'growing');
      if (next) out.add(next.id);
    }
    return out;
  });

  /** «La luz» drawn on the canvas — only live branches hold light; a stale
   *  value on an achieved/resting record stays visually inert. */
  protected lightOf(point: LayoutPoint): 'sunlit' | 'steady' | 'shade' {
    const status = point.node.status;
    if (status !== 'seed' && status !== 'growing') return 'steady';
    const p = point.node.priority;
    return p === 'sunlit' || p === 'shade' ? p : 'steady';
  }

  /** The label field: every branch name, wrapped and packed ONCE per layout
   *  change — never per zoom, never per focus. Visibility is therefore
   *  identical at every k by construction (tree-labels.ts owns the law). */
  private readonly labelField = computed(() => {
    const points = this.layout().points;
    const inputs = labelInputsFrom(points, {
      currentNodeId: this.tree().currentNodeId,
      labeledChainIds: this.nextStepIds(),
      // «La luz»: sunlit titles read slightly larger (the owner's typographic
      // hierarchy, upward only). The packer reserves the width — emphasis can
      // never cause overlap — plus room for the rayito glyph.
      emphasisOf: (p) => (this.lightOf(p) === 'sunlit' ? 1.12 : 1),
      leadGlyphOf: (p) => (this.lightOf(p) === 'sunlit' ? 10 : 0),
    });
    return packLabels(inputs, this.labelMeasure(), points);
  });

  protected labelFor(point: LayoutPoint): LabelBlock | undefined {
    return this.labelField().get(point.node.id);
  }

  protected readonly labelLinks = computed(() => {
    const field = this.labelField();
    const links: { id: string; path: string }[] = [];
    for (const point of this.layout().points) {
      const block = field.get(point.node.id);
      if (!block) continue;
      const edgeX = Math.max(block.cx - block.width / 2 + 3, Math.min(point.x, block.cx + block.width / 2 - 3));
      const edgeY = Math.max(block.top, Math.min(point.y, block.top + block.height));
      const dx = edgeX - point.x;
      const dy = edgeY - point.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 15 || (Math.abs(block.cx - point.x) < 22 && distance < 25)) continue;
      // Leave the glyph clear and end at the nearest point of the title.
      links.push({
        id: point.node.id,
        path: `M ${point.x + dx * 10 / distance} ${point.y + dy * 10 / distance} L ${edgeX} ${edgeY}`,
      });
    }
    return links;
  });

  protected readonly focusedPoint = computed(() => {
    const id = this.focusedId();
    return id ? this.layout().byId.get(id) : undefined;
  });

  /** Sunlit nodes grow their glyph — attention has size (composes with the
   *  capullo's lean; empty string keeps other glyphs' transforms clean). */
  protected glyphScale(point: LayoutPoint): string {
    return this.lightOf(point) === 'sunlit' ? ' scale(1.35)' : '';
  }

  /** The growing capullo leans along its limb's incoming direction —
   *  tempered toward the sky (phototropism), never lying flat. Reads the
   *  SAME geometry the limb is drawn with (leader/fork aware). */
  protected saplingAngle(point: LayoutPoint): number {
    if (!point.parent) return 0;
    const plan = this.limbPlan().get(point.node.id);
    if (!plan) return 0;
    const deg = (Math.atan2(point.y - plan.geom.c2y, point.x - plan.geom.c2x) * 180) / Math.PI + 90;
    const normalized = ((deg + 180) % 360) - 180;
    return Math.max(-70, Math.min(70, normalized * 0.8));
  }

  protected nodeLabel(point: LayoutPoint): string {
    const t = this.i18n.t();
    const children = this.nodes.childrenOf(point.node).length;
    let label = this.i18n.fill(t.a11y.nodeLabel, {
      title: point.node.title,
      status: t.status[point.node.status],
    });
    if (children) label += `, ${this.i18n.plural(children, t.a11y.withChildren)}`;
    // A container heart ANNOUNCES itself (0.0.115 P8): sighted users see the
    // rings glyph; the screen reader deserves the same landmark.
    if (children && this.nodes.heartOf(point.node.treeId)?.id === point.node.id) {
      label += `, ${t.a11y.heart}`;
    }
    const light = this.lightOf(point);
    if (light !== 'steady') label += `, ${t.a11y.light[light]}`;
    return label;
  }

  /** Frame the WHOLE tree; when even the 0.5 floor can't fit it, keep that
   *  zoom and center on the 📍 neighborhood instead (panning reaches the rest). */
  fitTree(): void {
    const layout = this.layout();
    if (!layout.points.length) return;
    const svg = this.svgRef().nativeElement;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;

    // The tree STANDS on the scenery's meadow line — never floats.
    const groundScreen = rect.height * 0.8;
    const padX = 40;
    const worldW = layout.width + 120; // label + jitter margin
    const fitK = Math.min(
      (rect.width - padX * 2) / worldW,
      (groundScreen - 70) / (layout.height + 90),
    );
    // Young trees should still fill the view instead of drowning in it.
    const fillK = (rect.height * 0.42) / Math.max(layout.height + 60, 180);
    const currentId = this.tree().currentNodeId;
    const current = currentId ? layout.byId.get(currentId) : null;
    const near = current ?? layout.points[layout.points.length - 1];
    // On a phone a canopy wider than two screens already needs panning at
    // 0.5×. Keep the wider overview for medium trees that nearly fit.
    const closeUp = rect.width < 560 && layout.width > 2 * rect.width;
    const k = closeUp ? 1 : Math.min(1.6, Math.max(0.5, Math.min(fitK, Math.max(1.15, fillK))));
    this.fitsWhole = k <= fitK;
    const cx = closeUp ? near.x : this.fitsWhole || !current ? layout.minX + layout.width / 2 : current.x;

    this.k.set(k);
    this.restingK = k;
    const tx = rect.width / 2 - cx * k;
    const ty = closeUp ? rect.height * 0.52 - near.y * k : groundScreen - this.groundY() * k;
    const position = this.fitsWhole ? { tx, ty } : this.clampPan(tx, ty, k);
    this.tx.set(position.tx);
    this.ty.set(closeUp ? position.ty : ty);
    if (!this.focusedId()) {
      this.focusedId.set(near.node.id);
    }
  }

  /** The fitted zoom — with a mouse the tree stands still until zoomed in. */
  private restingK = 0;

  /** True when the whole tree fits the viewport at the resting zoom. */
  private fitsWhole = true;

  private panUnlocked(): boolean {
    // An overflowing tree must always be pannable — even with a mouse.
    return this.k() > this.restingK * 1.04 || !this.fitsWhole;
  }

  /** The tree can never wander out of sight: at least 120px of it stays visible. */
  private clampPan(tx: number, ty: number, k: number): { tx: number; ty: number } {
    const rect = this.svgRef().nativeElement.getBoundingClientRect();
    const l = this.layout();
    const margin = 120;
    const left = l.minX * k;
    const right = (l.minX + l.width) * k;
    const top = l.minY * k;
    const bottom = (l.minY + l.height) * k;
    const txMin = Math.min(margin - right, rect.width - margin - left);
    const txMax = Math.max(margin - right, rect.width - margin - left);
    const tyMin = Math.min(margin - bottom, rect.height - margin - top);
    const tyMax = Math.max(margin - bottom, rect.height - margin - top);
    return {
      tx: Math.min(txMax, Math.max(txMin, tx)),
      ty: Math.min(tyMax, Math.max(tyMin, ty)),
    };
  }

  /** Zoom around the viewport center (the +/− buttons). */
  zoomBy(factor: number): void {
    const rect = this.svgRef().nativeElement.getBoundingClientRect();
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const k = Math.min(2.5, Math.max(0.4, this.k() * factor));
    const ratio = k / this.k();
    const c = this.clampPan(mx - ratio * (mx - this.tx()), my - ratio * (my - this.ty()), k);
    this.tx.set(c.tx);
    this.ty.set(c.ty);
    this.k.set(k);
  }

  /* ------------------------------------------------------------------ */
  /* Pointer pan / pinch                                                 */
  /* ------------------------------------------------------------------ */

  protected onPointerDown(ev: PointerEvent): void {
    try {
      (ev.target as Element).setPointerCapture?.(ev.pointerId);
    } catch {
      /* synthetic or already-released pointer — capture is best-effort */
    }
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    this.movedSinceDown = false;
    if (this.pointers.size === 1) {
      this.panStart = { x: ev.clientX, y: ev.clientY, tx: this.tx(), ty: this.ty() };
      this.pinchStart = null;
    } else if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        k: this.k(),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        tx: this.tx(),
        ty: this.ty(),
      };
      this.panStart = null;
    }
  }

  protected onPointerMove(ev: PointerEvent): void {
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this.pointers.size === 1 && this.panStart) {
      const dx = ev.clientX - this.panStart.x;
      const dy = ev.clientY - this.panStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) this.movedSinceDown = true;
      // Fingers always pan (within the corral); a mouse only pans once zoomed in.
      if (ev.pointerType !== 'mouse' || this.panUnlocked()) {
        const c = this.clampPan(this.panStart.tx + dx, this.panStart.ty + dy, this.k());
        this.tx.set(c.tx);
        this.ty.set(c.ty);
      }
    } else if (this.pointers.size === 2 && this.pinchStart) {
      this.movedSinceDown = true;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const scale = dist / this.pinchStart.dist;
      const k = Math.min(2.5, Math.max(0.4, this.pinchStart.k * scale));
      const ratio = k / this.pinchStart.k;
      const rect = this.svgRef().nativeElement.getBoundingClientRect();
      const mx = this.pinchStart.midX - rect.left;
      const my = this.pinchStart.midY - rect.top;
      this.k.set(k);
      const c = this.clampPan(
        mx - ratio * (mx - this.pinchStart.tx),
        my - ratio * (my - this.pinchStart.ty),
        k,
      );
      this.tx.set(c.tx);
      this.ty.set(c.ty);
    }
  }

  protected onPointerUp(ev: PointerEvent): void {
    this.pointers.delete(ev.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    if (this.pointers.size === 0) this.panStart = null;
    if (this.pointers.size === 1) {
      const [p] = [...this.pointers.values()];
      this.panStart = { x: p.x, y: p.y, tx: this.tx(), ty: this.ty() };
    }
  }

  /** A title opens its branch. On bare canvas the closest branch wins.
   *  Drags never count as taps, and the note and plant buttons act directly. */
  protected onCanvasClick(ev: MouseEvent): void {
    const target = ev.target;
    if (!(target instanceof Element) || target.closest('.note-mark, .plant-bud')) return;
    // An assistive action can activate the named SVG treeitem without a
    // pointer. In that case the element, rather than its coordinates, is the target.
    if (ev.detail === 0) {
      const id = target.closest('.node')?.getAttribute('data-node-id');
      const point = id ? this.layout().byId.get(id) : undefined;
      if (point) this.openPoint(point);
      return;
    }
    if (this.movedSinceDown) return;
    const rect = this.svgRef().nativeElement.getBoundingClientRect();
    const k = this.k();
    const wx = (ev.clientX - rect.left - this.tx()) / k;
    const wy = (ev.clientY - rect.top - this.ty()) / k;
    // Resolve against the painted bounds even when a nearby node's hit area
    // happens to sit above the title in the SVG.
    for (const block of this.labelField().values()) {
      if (Math.abs(wx - block.cx) > block.width / 2 || wy < block.top || wy > block.top + block.height) continue;
      const point = this.layout().byId.get(block.id);
      if (point) this.openPoint(point);
      return;
    }
    let best: LayoutPoint | null = null;
    let bestD = Infinity;
    for (const p of this.layout().points) {
      const d = Math.hypot(p.x - wx, p.y - wy);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    // Reach: at least 28 screen px, at least 20 world units.
    if (!best || bestD > Math.max(28 / k, 20)) return;
    this.openPoint(best);
  }

  protected openPoint(point: LayoutPoint): void {
    this.focusNode(point.node.id);
    this.nodeOpened.emit(point.node);
  }

  protected onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const rect = this.svgRef().nativeElement.getBoundingClientRect();
    if (ev.ctrlKey || ev.metaKey) {
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k = Math.min(2.5, Math.max(0.4, this.k() * factor));
      const ratio = k / this.k();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const c = this.clampPan(mx - ratio * (mx - this.tx()), my - ratio * (my - this.ty()), k);
      this.tx.set(c.tx);
      this.ty.set(c.ty);
      this.k.set(k);
    } else {
      const c = this.clampPan(this.tx() - ev.deltaX * 0.6, this.ty() - ev.deltaY * 0.6, this.k());
      this.ty.set(c.ty);
      this.tx.set(c.tx);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard navigation (roving tabindex)                               */
  /* ------------------------------------------------------------------ */

  protected onNodeKeydown(ev: KeyboardEvent, point: LayoutPoint): void {
    const move = (target: LayoutPoint | null | undefined) => {
      if (!target) return;
      ev.preventDefault();
      this.focusNode(target.node.id);
    };

    switch (ev.key) {
      case 'ArrowDown':
        move(point.parent);
        break;
      case 'ArrowUp': {
        // Up a chain link continues the path; otherwise into the first child.
        const upId = point.chainNextId ?? this.nodes.childrenOf(point.node)[0]?.id;
        move(upId ? this.layout().byId.get(upId) : null);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight': {
        // Chain links have no lateral siblings — their layout parent is the
        // PREVIOUS link, so "siblings" would be that link's real children
        // and ArrowRight jumped to an unrelated niece. The path is Up/Down.
        if (point.chain) break;
        const siblings = point.parent
          ? this.nodes.childrenOf(point.parent.node)
          : this.nodes.rootsOf(this.tree().id);
        const idx = siblings.findIndex((s) => s.id === point.node.id);
        const next = siblings[idx + (ev.key === 'ArrowRight' ? 1 : -1)];
        move(next ? this.layout().byId.get(next.id) : null);
        break;
      }
      case 'Home': {
        const currentId = this.tree().currentNodeId;
        if (currentId) move(this.layout().byId.get(currentId));
        break;
      }
      case '+':
      case 'p':
        ev.preventDefault();
        this.plantRequested.emit(point.node);
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        this.openPoint(point);
        break;
    }
  }

  focusNode(id: string): void {
    this.focusedId.set(id);
    const point = this.layout().byId.get(id);
    if (point) this.panIntoView(point);
    queueMicrotask(() => {
      this.host.nativeElement
        .querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  private panIntoView(point: LayoutPoint): void {
    const rect = this.svgRef().nativeElement.getBoundingClientRect();
    const sx = point.x * this.k() + this.tx();
    const sy = point.y * this.k() + this.ty();
    const margin = 80;
    const topMargin = Math.min(rect.height / 2, Math.max(margin, this.focusReadout().nativeElement.offsetHeight + 28));
    let dx = 0;
    let dy = 0;
    if (sx < margin) dx = margin - sx;
    if (sx > rect.width - margin) dx = rect.width - margin - sx;
    if (sy < topMargin) dy = topMargin - sy;
    else if (sy > rect.height - margin) dy = rect.height - margin - sy;
    this.tx.set(this.tx() + dx);
    this.ty.set(this.ty() + dy);
  }
}
