import { Component, DestroyRef, ElementRef, computed, effect, inject, signal } from '@angular/core';
import { FinderSheet } from './finder-sheet';
import {
  CATTAILS,
  CLOVERS,
  BUSHES,
  DAISIES,
  GRASS,
  PETAL_ANGLES,
  RICH_TUFTS,
  RIPPLE_1,
  RIPPLE_2,
  SPIKES,
  STONES,
  STREAM_PATH,
  SUN_PATCHES,
  SceneFlower,
} from './meadow-scenery';
import { inputValue } from '../../shared/ui/dom';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { HintChip } from '../../shared/ui/hint-chip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { ForestQuotaError, type QuotaDenial } from '../../core/repos/forest-mutations.service';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { AccentToken, Feeling, Tree } from '../../core/db/schema';
import { deriveAccent, ritualKind } from '../../core/harvest';
import { ConserveriaService } from '../../core/conserveria.service';
import { DespedidaSheet } from './despedida-sheet';
import { hash } from './tree-layout';
import { MiniTree } from './mini-tree';
import { SceneBackdrop } from './scene-backdrop';
import { SpiralGlyph } from './spiral';
import { WeatherFront } from './weather-front';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { FlowerSpec, flowerFor, jamTint } from './flora';
import { FlowerGlyph } from './flower';
import { FocusSessionService } from '../../core/focus-session.service';
import { PerchAnchorService } from '../../core/perch-anchor.service';
import { PerchBody } from '../../shared/ui/perch-body';
import { PlanLimitSheet } from '../access/plan-limit-sheet';

const ACCENTS: AccentToken[] = ['moss', 'sage', 'sky', 'clay', 'lavender', 'sand', 'rose', 'pine'];
const STARTER_BRANCH_FAILURE = Symbol('starter-branch-failure');
type PlanLimitDecision = Extract<
  QuotaDenial,
  { readonly reason: 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT' }
>;

/**
 * "El Prado" — the forest home as a living scene. Every tree is a real
 * miniature of its data, standing on the meadow; a stream winds through
 * once three trees grow together, and a flower blooms per achieved goal.
 */
@Component({
  selector: 'app-forest',
  imports: [
    RouterLink,
    MiniTree,
    SceneBackdrop,
    WeatherFront,
    FlowerGlyph,
    SpiralGlyph,
    SheetDirective,
    PerchBody,
    HintChip,
    ConfirmSheet,
    FinderSheet,
    DespedidaSheet,
    PlanLimitSheet,
  ],
  templateUrl: './forest.html',
  styleUrl: './forest.scss',
  // Drag listeners live on the document: live reordering moves the grip in
  // the DOM, which breaks pointer capture mid-drag.
  host: {
    '(document:pointermove)': 'moveOver($event)',
    '(document:pointerup)': 'endMove($event)',
    '(document:pointercancel)': 'endMove($event)',
  },
})
export class ForestPage {
  protected readonly inputValue = inputValue;
  protected readonly i18n = inject(I18nService);
  protected readonly trees = inject(TreesRepo);
  protected readonly nodes = inject(NodesRepo);
  protected readonly harvests = inject(HarvestsRepo);
  protected readonly accents = ACCENTS;

  protected readonly creating = signal(false);
  protected readonly newName = signal('');
  protected readonly newAccent = signal<AccentToken>('moss');
  protected readonly planLimit = signal<PlanLimitDecision | null>(null);
  private readonly growthError = signal<unknown | null>(null);
  protected readonly growthErrorText = computed(() => {
    const error = this.growthError();
    if (!error) return '';
    const copy = this.i18n.t().forest.errors;
    if (error === STARTER_BRANCH_FAILURE) return copy.starterBranches;
    if (!(error instanceof ForestQuotaError)) return copy.unknown;
    switch (error.decision.reason) {
      case 'ACCESS_LEASE_REQUIRED':
        return copy.accessLeaseRequired;
      case 'ACTIVE_TREE_LIMIT':
        return this.i18n.fill(copy.activeTreeLimit, { limit: error.decision.limit });
      case 'VISIBLE_BRANCH_LIMIT':
        return this.i18n.fill(copy.visibleBranchLimit, { limit: error.decision.limit });
      default:
        return copy.unknown;
    }
  });
  /** Tree pending archive (confirm sheet open). */
  protected readonly archiving = signal<Tree | null>(null);
  /** «La despedida» (0.0.95): a fruited tree pending its closing ritual. */
  protected readonly farewelling = signal<Tree | null>(null);
  private readonly toast = inject(ToastService);
  private readonly settings = inject(SettingsService);
  private readonly conserveria = inject(ConserveriaService);

  /** Prunable example saplings on the empty meadow — never a blank canvas. */
  protected readonly starterKinds = ['school', 'home', 'project'] as const;
  protected readonly startersHidden = computed(() => this.settings.settings().startersHidden);

  private readonly checkins = inject(CheckinsRepo);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  constructor() {
    // Check-in's empty-forest exit lands here ready to plant.
    if (this.route.snapshot.queryParamMap.has('plant')) {
      this.creating.set(true);
      const params = { ...this.route.snapshot.queryParams, plant: null };
      void this.router.navigate([], { queryParams: params, replaceUrl: true });
    }

    // The stream's on-screen geometry moves with the window — keep the
    // dry-feet clamp honest across resizes.
    const onResize = () => this.viewportSize.set({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));

    // Chromium treats document touchmove listeners as passive by default;
    // dragging needs a REAL preventDefault or the browser steals the gesture
    // for scrolling and fires pointercancel mid-drag.
    const lockTouch = (ev: TouchEvent) => {
      if (this.draggingId()) ev.preventDefault();
    };
    document.addEventListener('touchmove', lockTouch, { passive: false });
    inject(DestroyRef).onDestroy(() => document.removeEventListener('touchmove', lockTouch));

    // The parakeet waits on the session tree's crown — position by
    // MEASUREMENT (earned-size scales make math brittle): once after render,
    // again after the plots' 0.35s glide settles. Hidden while dragging (the
    // corner perch takes over; the tree is moving under a finger).
    effect((onCleanup) => {
      const treeId = this.sessionTreeId();
      const visible =
        treeId !== null && !this.draggingId() && this.pageTrees().some((t) => t.id === treeId);
      this.viewportSize(); // re-measure on resize
      if (!visible) {
        this.crownPerchPos.set(null);
        return;
      }
      const measure = () => {
        const band = this.host.nativeElement.querySelector('.plots');
        const svg = this.host.nativeElement.querySelector<SVGSVGElement>(
          `.plot[data-tree-id="${CSS.escape(treeId)}"] app-mini-tree svg`,
        );
        if (!band || !svg) {
          this.crownPerchPos.set(null);
          return;
        }
        const b = band.getBoundingClientRect();
        const m = svg.getBoundingClientRect();
        // The svg box has headroom above short trees — perch on the PAINTED
        // crown (getBBox), not the viewBox top.
        let crownY = m.top;
        try {
          const painted = svg.getBBox();
          crownY = m.top + (painted.y / 160) * m.height;
        } catch {
          /* detached svg — the raf pass will retry */
        }
        this.crownPerchPos.set({ x: (m.left + m.right) / 2 - b.left, y: crownY - b.top });
      };
      const first = requestAnimationFrame(measure);
      const settle = setTimeout(measure, 480);
      onCleanup(() => {
        cancelAnimationFrame(first);
        clearTimeout(settle);
      });
    });

    // While the crown holds the parakeet, the corner perch yields.
    effect(() => {
      if (this.crownPerchPos()) this.perchAnchor.claim('forest');
      else this.perchAnchor.release('forest');
    });
    inject(DestroyRef).onDestroy(() => this.perchAnchor.release('forest'));
  }

  /* ------------------------------- the parakeet on the session tree's crown */

  protected readonly focus = inject(FocusSessionService);
  private readonly perchAnchor = inject(PerchAnchorService);

  /** The tree the live session's branch belongs to (null for «solo estar»). */
  private readonly sessionTreeId = computed(() => {
    const id = this.focus.active()?.nodeId;
    if (!id) return null;
    const node = this.nodes.byId().get(id);
    if (!node || node.archivedAt || node.deletedAt) return null;
    const tree = this.trees.byId().get(node.treeId);
    return tree && !tree.archivedAt && !tree.deletedAt ? tree.id : null;
  });

  /** Crown top-center in `.plots`-band coordinates; null → corner fallback. */
  protected readonly crownPerchPos = signal<{ x: number; y: number } | null>(null);

  /* ----------------------------------------- «buscar una rama» (finder) */

  protected readonly finderOpen = signal(false);
  /** `?mood=` dev/demo override, else the latest check-in's feeling. */
  private readonly moodOverride = new URLSearchParams(location.search).get(
    'mood',
  ) as Feeling | null;
  protected readonly mood = computed<Feeling | null>(
    () => this.moodOverride ?? this.checkins.latest()?.feeling ?? null,
  );

  /** The stream flows once the forest has three trees (winding ribbon + ripples). */
  protected readonly hasStream = computed(() => this.trees.active().length >= 3);

  protected readonly streamPath = STREAM_PATH;
  protected readonly ripple1 = RIPPLE_1;
  protected readonly ripple2 = RIPPLE_2;

  /** One meadow flower per achieved goal — each in ITS tree's species. */
  protected readonly flowers = computed<SceneFlower[]>(() => {
    const achieved = this.nodes.visible().filter((n) => n.status === 'achieved');
    return achieved.slice(0, 26).map((node) => {
      const h = hash(node.id + ':meadow');
      const tree = this.trees.byId().get(node.treeId);
      return {
        x: 30 + (h % 940),
        y: 196 + ((h >> 8) % 52),
        scale: 0.42 + ((h >> 4) % 20) / 100,
        spec: flowerFor(tree?.accent ?? 'rose', node.treeId),
        sway: -8 + (h % 17),
      };
    });
  });

  /* Static scenery lives in meadow-scenery.ts (pure, fixed-seed). */
  protected readonly grass = GRASS;
  protected readonly sunPatches = SUN_PATCHES;
  protected readonly bushes = BUSHES;
  protected readonly richTufts = RICH_TUFTS;
  protected readonly spikes = SPIKES;
  protected readonly daisies = DAISIES;
  protected readonly clovers = CLOVERS;
  protected readonly cattails = CATTAILS;
  protected readonly stones = STONES;

  protected readonly petalAngles = PETAL_ANGLES;

  /* -------------------------------------------- arrange your own forest */

  /** Live order while dragging (ids); null when at rest. */
  protected readonly dragPreview = signal<string[] | null>(null);
  protected readonly draggingId = signal<string | null>(null);
  /** The carried plot's live position (band %) + FROZEN scale — while
   *  dragging, the tree renders from the finger, not from its anchor slot.
   *  Scale is frozen at grab: `slot.s` is index-dependent and would snap on
   *  every preview splice. */
  protected readonly dragPos = signal<{ x: number; b: number; s: number } | null>(null);
  /** The plot gliding home right after a drop (spring transition + settle). */
  protected readonly settlingId = signal<string | null>(null);
  /** Pointer→bottom-center offset at grab, so the tree doesn't jump. */
  private grabDX = 0;
  private grabDY = 0;
  private bandEl: HTMLElement | null = null;
  /** The ONE pointer that owns the drag — all other pointers are ignored. */
  private dragPointerId: number | null = null;
  /** Settle generation: two quick drops of the same tree must not let the
   *  first drop's timeout cut the second settle short. */
  private settleGen = 0;

  /** What the meadow renders: the drag preview if one is in flight. */
  protected readonly displayTrees = computed(() => {
    const base = this.trees.active();
    const preview = this.dragPreview();
    if (!preview) return base;
    const byId = new Map(base.map((t) => [t.id, t]));
    return preview.map((id) => byId.get(id)).filter((t): t is Tree => !!t);
  });

  /** Press pending on a plot: becomes a drag on movement (mouse) or after a
   *  long-press (touch); otherwise the tap navigates as always. */
  private pendingDrag: {
    tree: Tree;
    x: number;
    y: number;
    pointerId: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  private suppressClick = false;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected plotDown(ev: PointerEvent, tree: Tree): void {
    // One gesture at a time: while a drag (or an armed press) is alive, a
    // SECOND finger must not reset the bookkeeping, hijack the grab, or —
    // via its later click — navigate mid-drag. And only the primary button
    // grabs: a right-button press used to start a drag and then pop the
    // native context menu on top of the drop.
    if (this.draggingId() || this.pendingDrag || ev.button !== 0) return;
    this.suppressClick = false;
    this.dragMoved = false;
    if ((ev.target as Element).closest('.plot-archive')) return;
    const pending = {
      tree,
      x: ev.clientX,
      y: ev.clientY,
      pointerId: ev.pointerId,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    // Holding also lifts the tree (mouse a bit sooner than a finger) —
    // matching the natural "press and hold to grab it" instinct.
    pending.timer = setTimeout(
      () => {
        if (this.pendingDrag === pending) this.beginDrag(tree);
      },
      // A real thumb can't hold perfectly still — grab a bit sooner on touch.
      ev.pointerType === 'mouse' ? 250 : 300,
    );
    this.pendingDrag = pending;
  }

  /** True once the pointer really traveled during a drag. */
  private dragMoved = false;

  private beginDrag(tree: Tree): void {
    const pointerId = this.pendingDrag?.pointerId;
    const px = this.pendingDrag?.x ?? 0;
    const py = this.pendingDrag?.y ?? 0;
    this.clearPending();
    // Re-grabbing a tree inside its ~520ms settle window: the .settling
    // transition outranks .dragging's `transition: none` (same specificity,
    // later in source) and the tree would rubber-band behind the finger.
    this.settlingId.set(null);
    // Stale offsets from the PREVIOUS drag must never leak into this one
    // (the measure block below is skipped when the plot unmounted mid-hold).
    this.grabDX = 0;
    this.grabDY = 0;
    // A lone tree has no neighbor to trade places with — say so kindly.
    if (this.trees.active().length < 2) {
      this.toast.show({ message: this.i18n.t().forest.moveNeedsTwo });
      return;
    }
    // Capture the pointer on the HOST (it never unmounts): touch pointers
    // are implicitly captured by the pressed PLOT, and a mid-drag clearing
    // flip unmounts that plot — the captured stream would die with a
    // pointercancel and collapse the drag. Retargeted here, events survive
    // any DOM churn below.
    if (pointerId !== undefined) {
      try {
        this.host.nativeElement.setPointerCapture(pointerId);
      } catch {
        /* synthetic/expired pointers may not be capturable — fine */
      }
    }
    this.dragPointerId = pointerId ?? null;
    // From here on the tree rides the finger: seed its live position from the
    // RENDERED rect (frame 1 = exactly where it stands, zero jump) and keep
    // the pointer→bottom-center offset. With transform-origin 50% 100% +
    // translateX(-50%), the rect's bottom-center IS the (left%, bottom%)
    // anchor — scale never moves it.
    this.bandEl = this.host.nativeElement.querySelector('.plots');
    const plotEl = this.host.nativeElement.querySelector<HTMLElement>(
      `[data-tree-id="${CSS.escape(tree.id)}"]`,
    );
    if (plotEl && this.bandEl) {
      const r = plotEl.getBoundingClientRect();
      const band = this.bandEl.getBoundingClientRect();
      this.grabDX = px - (r.left + r.right) / 2;
      this.grabDY = py - r.bottom;
      this.dragPos.set({
        x: (((r.left + r.right) / 2 - band.left) / band.width) * 100,
        b: ((band.bottom - r.bottom) / band.height) * 100,
        s: plotEl.offsetWidth ? r.width / plotEl.offsetWidth : 1,
      });
    }
    this.draggingId.set(tree.id);
    this.dragPreview.set(this.trees.active().map((t) => t.id));
    this.suppressClick = true;
  }

  private clearPending(): void {
    if (this.pendingDrag?.timer) clearTimeout(this.pendingDrag.timer);
    this.pendingDrag = null;
  }

  /** Swallow the click that follows a drag so the plot doesn't navigate. */
  protected plotClick(ev: MouseEvent): void {
    if (this.suppressClick) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      this.suppressClick = false;
    }
  }

  /** Throttle for mid-drag clearing flips (edge hover). */
  private lastDragFlip = 0;

  protected moveOver(ev: PointerEvent): void {
    const pending = this.pendingDrag;
    if (pending && !this.draggingId() && ev.pointerId === pending.pointerId) {
      const dist = Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y);
      if (ev.pointerType === 'mouse') {
        if (dist > 8) this.beginDrag(pending.tree);
      } else if (dist > 26) {
        // A DELIBERATE slide before the long-press is a scroll, not a drag —
        // but a thumb's natural tremor (the old 14px) must not cancel the
        // grab (Hector's phone: "no puedo intercambiar árboles").
        this.clearPending();
      }
    }
    const dragId = this.draggingId();
    const preview = this.dragPreview();
    if (!dragId || !preview) return;
    // Only the grabbing pointer steers: a resting palm or a second thumb
    // must not teleport the tree, flip pages, or splice the order.
    if (this.dragPointerId !== null && ev.pointerId !== this.dragPointerId) return;
    this.dragMoved = true;

    // The tree rides the finger — BEFORE the edge check, so it keeps
    // tracking while parked at the edge waiting for a clearing flip. Band
    // rect per move keeps it honest across scroll/resize mid-drag.
    if (this.bandEl) {
      const band = this.bandEl.getBoundingClientRect();
      const prev = this.dragPos();
      this.dragPos.set({
        x: Math.min(100, Math.max(0, ((ev.clientX - this.grabDX - band.left) / band.width) * 100)),
        b: Math.max(
          -8,
          Math.min(108, ((band.bottom - (ev.clientY - this.grabDY)) / band.height) * 100),
        ),
        s: prev?.s ?? 1,
      });
    }

    // Carrying a tree to the meadow's edge walks to the NEXT clearing — the
    // only way a drag can cross pages. Throttled so one hover flips once.
    const EDGE = 52;
    const dir = ev.clientX < EDGE ? -1 : ev.clientX > window.innerWidth - EDGE ? 1 : 0;
    if (dir) {
      const now = Date.now();
      const target = this.page() + dir;
      if (now - this.lastDragFlip > 600 && target >= 0 && target < this.pageCount()) {
        this.lastDragFlip = now;
        this.page.set(target);
      }
      return; // the new clearing's plots land next move
    }

    for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const host = (el as Element).closest?.('[data-tree-id]') as HTMLElement | null;
      const overId = host?.dataset['treeId'];
      if (!overId || overId === dragId) continue;
      const from = preview.indexOf(dragId);
      const to = preview.indexOf(overId);
      if (from === -1 || to === -1 || from === to) return;
      const next = [...preview];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      this.dragPreview.set(next);
      return;
    }
  }

  protected async endMove(ev?: PointerEvent): Promise<void> {
    // A pointer that isn't part of the gesture lifting must end NOTHING —
    // neither the armed press nor the live drag (second-finger taps used to
    // commit half-finished reorders).
    if (ev) {
      if (this.pendingDrag && ev.pointerId !== this.pendingDrag.pointerId) return;
      if (this.draggingId() && this.dragPointerId !== null && ev.pointerId !== this.dragPointerId) {
        return;
      }
    }
    this.clearPending();
    const dragId = this.draggingId();
    if (!dragId) return;
    const preview = this.dragPreview();
    // Same CD pass: .dragging off + bindings back to the slot → the tree
    // glides home from under the finger (the after-change style has its
    // transitions again). .settling retargets that glide with the spring.
    this.draggingId.set(null);
    this.dragPos.set(null);
    this.bandEl = null;
    this.dragPointerId = null;
    if (this.dragMoved) {
      const gen = ++this.settleGen;
      this.settlingId.set(dragId);
      setTimeout(() => {
        if (this.settleGen === gen && this.settlingId() === dragId) this.settlingId.set(null);
      }, 520);
      // The click that trails this pointerup (if any) must not navigate —
      // but the flag must not LINGER either: when the drop lands off-plot no
      // click ever comes, and a stale flag used to swallow the next
      // keyboard Enter on a focused plot.
      setTimeout(() => (this.suppressClick = false));
    } else {
      // A hold that never traveled is just a slow click — let it navigate.
      this.suppressClick = false;
    }
    if (preview) await this.trees.setOrder(preview);
    // The preview lives until the commit lands — nulling it before the await
    // let displayTrees flash the OLD order under the settle glide. Guard: a
    // new drag may have begun while we waited.
    if (!this.draggingId()) this.dragPreview.set(null);
  }

  /** Keyboard rearranging: arrows swap the tree with its neighbor. */
  protected async nudge(ev: KeyboardEvent, tree: Tree): Promise<void> {
    // Never a second writer while a pointer drag holds the order.
    if (this.draggingId()) return;
    const dir =
      ev.key === 'ArrowLeft' || ev.key === 'ArrowUp'
        ? -1
        : ev.key === 'ArrowRight' || ev.key === 'ArrowDown'
          ? 1
          : 0;
    if (!dir) return;
    ev.preventDefault();
    const ids = this.trees.active().map((t) => t.id);
    const i = ids.indexOf(tree.id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await this.trees.setOrder(ids);
  }

  /* ----------------------------------------- the clearings ("claros") */

  /** Trees per clearing — every tree keeps a clear, tappable heart.
   *  Phones hold THREE: four grown crowns already jostle at 390px
   *  (Hector's report — "con más de 3 se satura"). */
  private readonly pageSizeValue =
    typeof matchMedia !== 'undefined' && matchMedia('(max-width: 700px)').matches ? 3 : 6;

  protected readonly page = signal(0);
  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.trees.active().length / this.pageSizeValue)),
  );
  protected readonly dots = computed(() => Array.from({ length: this.pageCount() }, (_, i) => i));

  /** The trees standing in the current clearing (drag preview respected).
   *  A tree being CARRIED rides along into whatever clearing is shown: if
   *  its plot unmounted on a mid-drag flip, the latched touch stream would
   *  die silently (no pointercancel — it just stops) and the drag would
   *  collapse. Kept mounted, the @for reuses its node (track by id) and the
   *  gesture survives the crossing. */
  protected readonly pageTrees = computed(() => {
    const size = this.pageSizeValue;
    const clamped = Math.min(this.page(), this.pageCount() - 1);
    const slice = this.displayTrees().slice(clamped * size, (clamped + 1) * size);
    const dragId = this.draggingId();
    if (dragId && !slice.some((t) => t.id === dragId)) {
      const dragged = this.displayTrees().find((t) => t.id === dragId);
      if (dragged) return [...slice, dragged];
    }
    return slice;
  });

  protected goPage(delta: number): void {
    this.page.set(Math.max(0, Math.min(this.pageCount() - 1, this.page() + delta)));
  }

  /** Archiving can shrink the meadow — never strand the view past the end. */
  private readonly pageClamp = effect(() => {
    const max = this.pageCount() - 1;
    if (this.page() > max) this.page.set(Math.max(0, max));
  });

  /** Hand-tuned constellations: for n trees, n organic anchors on the meadow
   *  band — x in % of the band, b (feet) in % of the band's height. Same-row
   *  neighbors keep breathing room; nothing ever climbs toward the sky. */
  private static readonly ARRANGEMENTS: ReadonlyArray<ReadonlyArray<{ x: number; b: number }>> = [
    [],
    [{ x: 50, b: 10 }],
    [
      { x: 28, b: 8 },
      { x: 72, b: 38 },
    ],
    [
      { x: 18, b: 6 },
      { x: 50, b: 38 },
      { x: 82, b: 10 },
    ],
    // Back-row anchors sit mid-BETWEEN front ones: every tree's heart stays
    // clear of its taller front neighbors (tappable by construction).
    [
      { x: 28, b: 8 },
      { x: 72, b: 6 },
      { x: 50, b: 38 },
      { x: 13, b: 34 },
    ],
    [
      { x: 18, b: 8 },
      { x: 50, b: 6 },
      { x: 82, b: 10 },
      { x: 34, b: 37 },
      { x: 66, b: 38 },
    ],
    [
      { x: 15, b: 6 },
      { x: 45, b: 10 },
      { x: 75, b: 8 },
      { x: 30, b: 37 },
      { x: 60, b: 38 },
      { x: 88, b: 35 },
    ],
  ];

  /** Live viewport — the stream's on-screen position depends on it. */
  private readonly viewportSize = signal({ w: window.innerWidth, h: window.innerHeight });

  /** DRY FEET: the highest a foot may stand at x% so the TRUNK BASE stays on
   *  the near bank of the stream — sampled from the SAME bezier the scene
   *  draws (centerline (1060,96)→(-60,208), width 22→46, xMidYMax slice).
   *  Wide windows scale the scene by WIDTH and the river climbs; percentages
   *  alone put trees in the water (shipped once — never again). */
  private bankLimitPct(xPct: number, treeScale: number): number {
    const { w, h } = this.viewportSize();
    const sceneH = Math.min(460, 0.58 * h);
    const scale = Math.max(w / 1000, sceneH / 260);
    const visibleVb = w / scale;
    const xVb = 500 - visibleVb / 2 + (xPct / 100) * visibleVb;
    let best = { d: Infinity, y: 150, half: 17 };
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      const bx = u * u * u * 1060 + 3 * u * u * t * 700 + 3 * u * t * t * 400 + t * t * t * -60;
      const by = u * u * u * 96 + 3 * u * u * t * 168 + 3 * u * t * t * 76 + t * t * t * 208;
      const d = Math.abs(bx - xVb);
      if (d < best.d) best = { d, y: by, half: (22 + 24 * t) / 2 };
    }
    const bankPx = (260 - (best.y + best.half)) * scale; // water's near edge, from the scene bottom
    const plotsH = Math.min(400, 0.5 * h);
    // Margin anatomy (measured, not guessed): .plots bottoms out 16px above
    // the painted scene (meadow padding); above the foot sit the name label
    // (2 lines worst case) and the mini's own ground inset — those scale with
    // the plot. Better a step further from the water than one toe in it.
    return Math.max(4, ((bankPx - 60 - 80 * treeScale) / plotsH) * 100);
  }

  /** A tree EARNS its size: branches + blooms (double weight) grow the plot —
   *  the meadow itself tells you which areas carry the most work. Bounded,
   *  saturating (√), and capped tighter in crowded clearings so every
   *  neighbor's heart stays tappable. */
  private growthFor(treeId: string): number {
    const content = this.countFor(treeId) + 2 * this.bloomsFor(treeId);
    const cap = this.pageTrees().length >= 5 ? 1.12 : 1.22;
    return Math.min(cap, Math.max(0.78, 0.72 + 0.13 * Math.sqrt(content)));
  }

  /** Where the i-th tree of this clearing stands: its anchor plus the tree's
   *  own small deterministic wobble — natural sprouts, never a stamped grid. */
  protected slotFor(i: number, tree: Tree): { x: number; b: number; s: number; z: number } {
    const n = Math.min(this.pageTrees().length, ForestPage.ARRANGEMENTS.length - 1);
    const anchor = ForestPage.ARRANGEMENTS[Math.max(1, n)][Math.min(i, n - 1)] ?? { x: 50, b: 10 };
    const h = hash(tree.id + ':meadow');
    const growth = this.growthFor(tree.id);
    const x = Math.min(89, Math.max(11, anchor.x + ((h % 5) - 2)));
    let b = Math.max(2, anchor.b + (((h >> 4) % 5) - 2));
    let s = Math.round((1.02 - (b / 40) * 0.2) * growth * 100) / 100;
    // Back rows hug the near bank — nobody ever stands in the water.
    if (this.hasStream() && b > 16) {
      b = Math.min(b, this.bankLimitPct(x, s));
      s = Math.round((1.02 - (b / 40) * 0.2) * growth * 100) / 100;
    }
    return { x, b, s, z: 10 + Math.round(40 - b) };
  }

  protected countFor(treeId: string): number {
    return (this.nodes.byTree().get(treeId) ?? []).length;
  }

  protected bloomsFor(treeId: string): number {
    return (this.nodes.byTree().get(treeId) ?? []).filter((n) => n.status === 'achieved').length;
  }

  /** Forest-level triage: this tree holds at least one «a pleno sol» branch. */
  protected hasSun(treeId: string): boolean {
    return (this.nodes.byTree().get(treeId) ?? []).some(
      (n) => n.priority === 'sunlit' && (n.status === 'seed' || n.status === 'growing'),
    );
  }

  /** «La espiral» (0.0.104): this tree holds living rituals — the sign wears
   *  the still mini-spiral, same pattern as the ☀️. */
  protected hasRituals(treeId: string): boolean {
    return (this.nodes.byTree().get(treeId) ?? []).some(
      (n) => ritualKind(n) !== null && n.status !== 'achieved' && n.status !== 'resting',
    );
  }

  /** Did this tree bear fruit? (any live harvest with its treeId) — gates the
   *  farewell ritual (elixir) vs the plain archive confirm. */
  private boreFruit(tree: Tree): boolean {
    return this.harvests.all().some((h) => h.treeId === tree.id);
  }

  protected askArchive(event: Event, tree: Tree): void {
    // The button lives inside the plot link — don't navigate.
    event.preventDefault();
    event.stopPropagation();
    // A second finger tapping a 🗃 mid-drag must not pop the confirm sheet
    // over the gesture.
    if (this.draggingId()) return;
    // A fruited tree closes with a despedida (elixir); a fruitless one with the
    // plain confirm.
    if (this.boreFruit(tree)) this.farewelling.set(tree);
    else this.archiving.set(tree);
  }

  protected async archiveTree(): Promise<void> {
    const asked = this.archiving();
    if (!asked) return;
    // The confirm sheet can sit open for minutes — archive the LIVE record,
    // not the snapshot (a cross-tab rename landing meanwhile must survive;
    // an already-archived one must not get a spurious re-stamp).
    const tree = this.trees.byId().get(asked.id) ?? asked;
    this.archiving.set(null);
    if (tree.archivedAt) return;
    await this.trees.archive(tree);
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().tree.archivedToast, { name: tree.name }),
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.trees.restore(tree),
      },
      UNDO_MS,
    );
  }

  /** «La despedida» (0.0.95): archive a fruited tree AND distill its elixir in
   *  one gesture. Undo restores the tree and removes the elixir. */
  protected async keepFarewell(carry: string): Promise<void> {
    const asked = this.farewelling();
    if (!asked) return;
    const tree = this.trees.byId().get(asked.id) ?? asked;
    this.farewelling.set(null);
    if (tree.archivedAt) return;
    const fruits = this.harvests.all().filter((h) => h.treeId === tree.id);
    const tint = jamTint(fruits.map((f) => f.accent));
    await this.trees.archive(tree);
    const elixir = await this.conserveria.distill({
      name: tree.name,
      treeId: tree.id,
      carry,
      accent: deriveAccent(fruits),
      tint: tint.tint,
      tintEdge: tint.tintEdge,
    });
    this.toast.show(
      {
        message: this.i18n.t().cosecha.elixir.minted,
        actionLabel: this.i18n.t().common.undo,
        action: () => {
          void this.trees.restore(tree);
          void this.conserveria.undistill(elixir.id);
        },
      },
      UNDO_MS,
    );
  }

  /** A tree is born WITH its first little branch (same name — rename any
   *  time): one naming, never an empty tree, instantly actionable in Ahora. */
  protected async create(): Promise<void> {
    const name = this.newName().trim();
    if (!name) return;
    this.growthError.set(null);
    try {
      await this.trees.create(name, this.newAccent());
    } catch (error) {
      if (this.capturePlanLimit(error)) return;
      this.growthError.set(error);
      return;
    }
    this.newName.set('');
    this.creating.set(false);
    // The newborn gets the highest order — walk to its clearing so it's seen.
    this.page.set(this.pageCount() - 1);
  }

  /** A starter sapling: a young tree with two example branches — content to
   *  prune and rename, never a form to fill. */
  protected async plantStarter(kind: 'school' | 'home' | 'project'): Promise<void> {
    const s = this.i18n.t().sow.starters[kind];
    const accent: AccentToken = kind === 'school' ? 'sky' : kind === 'home' ? 'clay' : 'moss';
    this.growthError.set(null);
    let tree: Tree;
    try {
      tree = await this.trees.create(s.name, accent);
    } catch (error) {
      if (this.capturePlanLimit(error)) return;
      this.growthError.set(error);
      return;
    }
    try {
      await this.nodes.plantMany(tree.id, [
        { parentId: tree.heartId, title: s.b1 },
        { parentId: tree.heartId, title: s.b2 },
      ]);
    } catch {
      this.growthError.set(STARTER_BRANCH_FAILURE);
    }
  }

  protected openCreate(): void {
    this.growthError.set(null);
    this.planLimit.set(null);
    this.creating.set(true);
  }

  protected closeCreate(): void {
    this.creating.set(false);
    this.growthError.set(null);
    this.planLimit.set(null);
  }

  private capturePlanLimit(error: unknown): boolean {
    if (!(error instanceof ForestQuotaError)) return false;
    const decision = error.decision;
    if (decision.reason !== 'ACTIVE_TREE_LIMIT' && decision.reason !== 'VISIBLE_BRANCH_LIMIT') {
      return false;
    }
    this.planLimit.set(decision);
    return true;
  }

  protected redeemFromPlanLimit(): void {
    this.planLimit.set(null);
    const current = this.router.url;
    const returnUrl = current.startsWith('/') && !current.startsWith('//') ? current : '/forest';
    void this.router.navigate(['/account'], {
      queryParams: { intent: 'redeem', returnUrl },
    });
  }

  /** "Prefiero empezar en blanco" — the examples bow out for good. */
  protected hideStarters(): void {
    void this.settings.patch({ startersHidden: true });
  }
}
