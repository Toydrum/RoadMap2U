import { Component, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { inputEl, inputValue } from '../../shared/ui/dom';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { HintChip } from '../../shared/ui/hint-chip';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { AccessService } from '../../core/access/access.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { ForestQuotaError, type QuotaDenial } from '../../core/repos/forest-mutations.service';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { FocusSessionService } from '../../core/focus-session.service';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { Feeling, TreeNode } from '../../core/db/schema';
import { Cadence } from '../../core/cadence';
import { CadencePicker } from '../node-detail/cadence-picker';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { ConserveriaService } from '../../core/conserveria.service';
import { deriveAccent } from '../../core/harvest';
import { jamTint } from './flora';
import { DespedidaSheet } from './despedida-sheet';
import { TreeCanvas } from './tree-canvas';
import { TreeOutline } from './tree-outline';
import { SceneBackdrop } from './scene-backdrop';
import { WeatherFront } from './weather-front';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { NodeDetail } from '../node-detail/node-detail';
import { DateReview } from '../check-in/date-review';
import { VisitSession } from '../../core/visit/visit-session';
import { PlanLimitSheet } from '../access/plan-limit-sheet';

type PlanLimitDecision = Extract<
  QuotaDenial,
  { readonly reason: 'ACTIVE_TREE_LIMIT' | 'VISIBLE_BRANCH_LIMIT' }
>;

@Component({
  selector: 'app-tree-view',
  imports: [
    RouterLink,
    TreeCanvas,
    TreeOutline,
    SceneBackdrop,
    WeatherFront,
    NodeDetail,
    DateReview,
    SheetDirective,
    HintChip,
    ConfirmSheet,
    CadencePicker,
    DespedidaSheet,
    PlanLimitSheet,
  ],
  templateUrl: './tree-view.html',
  styleUrl: './tree-view.scss',
})
export class TreeViewPage {
  protected readonly inputValue = inputValue;
  protected readonly inputEl = inputEl;
  /** Route param via withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly i18n = inject(I18nService);
  protected readonly trees = inject(TreesRepo);
  protected readonly nodes = inject(NodesRepo);
  private readonly access = inject(AccessService);
  private readonly router = inject(Router);

  /** Present only under /visit/:userId — the page then works on SOMEONE
   *  ELSE'S forest (route-scoped repos): session/archive affordances hide,
   *  the sky stays neutral (their feelings are private), back goes home. */
  protected readonly visit = inject(VisitSession, { optional: true });

  /** Archived and deleted-forever trees are NOT pages: a stale bookmark used
   *  to render a fully editable ghost (you could even plant live nodes under
   *  a tombstoned tree). The archive page is the door back. */
  protected readonly tree = computed(() => {
    const record = this.trees.byId().get(this.id());
    return record && !record.archivedAt && !record.deletedAt ? record : null;
  });

  protected readonly backLink = computed(() =>
    this.visit ? ['/visit', this.visit.userId()] : ['/forest'],
  );

  /** Friend visits are look-only: taps locate, nothing plants, no sheets.
   *  Guardians (editable visits) and the owner keep the whole toolkit. */
  protected readonly canEdit = computed(() => !this.visit || this.visit.editable());

  private readonly checkins = inject(CheckinsRepo);
  private readonly moodOverride = new URLSearchParams(location.search).get(
    'mood',
  ) as Feeling | null;
  protected readonly mood = computed<Feeling | null>(() =>
    this.visit ? null : (this.moodOverride ?? this.checkins.latest()?.feeling ?? null),
  );

  protected readonly openNode = signal<TreeNode | null>(null);

  private readonly route = inject(ActivatedRoute);
  /** `?node=` deep link (e.g. from "Tus huellas"): open that branch's sheet
   *  on arrival. A signal fed by the LIVE query params — the constructor
   *  snapshot ignored a second deep link into a reused page instance. */
  private readonly pendingOpenId = signal(this.route.snapshot.queryParamMap.get('node'));

  /** `?locate=` deep link (the finder): PAN to the branch, open nothing. */
  private readonly pendingLocateId = signal(this.route.snapshot.queryParamMap.get('locate'));

  constructor() {
    // takeUntilDestroyed (0.0.115 P1): route-scoped observables usually die
    // with the page, but a leaked subscription costs nothing to rule out.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = params.get('node');
      if (id) this.pendingOpenId.set(id);
      const locate = params.get('locate');
      if (locate) this.pendingLocateId.set(locate);
    });
    effect(() => {
      const pendingId = this.pendingLocateId();
      const canvas = this.canvas();
      if (!pendingId || !canvas) return;
      const node = this.nodes.byId().get(pendingId);
      if (!node || node.treeId !== this.id() || node.archivedAt || node.deletedAt) return;
      this.pendingLocateId.set(null);
      // After the one-time fitTree framing settles, pan to the branch.
      setTimeout(() => canvas.focusNode(pendingId), 350);
      const params = { ...this.route.snapshot.queryParams, locate: null };
      void this.router.navigate([], { queryParams: params, replaceUrl: true });
    });
    effect(() => {
      const pendingId = this.pendingOpenId();
      if (!pendingId || !this.canEdit()) return;
      const node = this.nodes.byId().get(pendingId);
      // Archived/tombstoned nodes aren't on the canvas — a stale deep link
      // must not open a sheet whose writes land on an invisible record.
      if (!node || node.treeId !== this.id() || node.archivedAt || node.deletedAt) return;
      this.pendingOpenId.set(null);
      this.openNode.set(node);
      const params = { ...this.route.snapshot.queryParams, node: null };
      void this.router.navigate([], { queryParams: params, replaceUrl: true });
    });
  }
  /** null = closed; { parent: null } = plant a root; { parent: node } = plant under it. */
  protected readonly planting = signal<{ parent: TreeNode | null } | null>(null);
  protected readonly reviewing = signal(false);
  protected readonly archiving = signal(false);
  protected readonly newTitle = signal('');
  /** Little branches planted since this sheet opened — a celebration, not a counter. */
  protected readonly plantedCount = signal(0);
  /** "Varios a la vez": one line = one branch; indent = child of the line above. */
  protected readonly sowMode = signal(false);
  protected readonly sowText = signal('');
  private readonly toast = inject(ToastService);
  private readonly focus = inject(FocusSessionService);
  /** First branch planted this sheet session — the burst invitation's door. */
  private burstFirstId: string | null = null;
  private burstInvited = false;

  /** Dates on THIS tree wanting a word. */
  protected readonly pendingReviews = computed(() =>
    this.nodes.needsDateReview().filter((n) => n.treeId === this.id()),
  );

  protected readonly branchCount = computed(() => {
    const heartId = this.tree()?.heartId;
    return (this.nodes.byTree().get(this.id()) ?? []).filter((node) => node.id !== heartId).length;
  });
  protected readonly branchLimit = computed(
    () => this.access.access().limits.maxVisibleBranchesPerTree,
  );
  protected readonly planLimit = signal<PlanLimitDecision | null>(null);
  protected readonly bloomCount = computed(
    () => (this.nodes.byTree().get(this.id()) ?? []).filter((n) => n.status === 'achieved').length,
  );

  protected onNodeOpened(node: TreeNode): void {
    if (!this.canEdit()) {
      this.canvas()?.focusNode(node.id); // look-only visit: locate, never open
      return;
    }
    this.openNode.set(node);
  }

  /* -------------------------------------------- the "tablita" outline */

  protected readonly outlineOpen = signal(false);
  private readonly canvas = viewChild(TreeCanvas);
  protected readonly outlineFocusId = computed(() => this.canvas()?.focusedId() ?? null);

  /** Outline tap: put the branch in view and speak its name — nothing opens. */
  protected locateNode(node: TreeNode): void {
    this.canvas()?.focusNode(node.id);
    if (window.innerWidth < 700) this.outlineOpen.set(false);
  }

  /** Second tap on the same row: open its sheet (locate-only on look-only visits). */
  protected outlineOpenNode(node: TreeNode): void {
    if (!this.canEdit()) {
      this.locateNode(node);
      return;
    }
    this.openNode.set(node);
    if (window.innerWidth < 980) this.outlineOpen.set(false);
  }

  /** Keep the sheet showing the live version of the node — and close it if
   *  the node stops existing on the canvas (archived in another tab). */
  protected readonly liveOpenNode = computed(() => {
    const open = this.openNode();
    if (!open) return null;
    const live = this.nodes.byId().get(open.id);
    return live && !live.archivedAt && !live.deletedAt ? live : null;
  });

  protected plantSheetTitle(): string {
    const target = this.planting();
    if (target?.parent) {
      return this.i18n.fill(this.i18n.t().node.plantUnder, { title: target.parent.title });
    }
    return this.i18n.t().node.newTitle;
  }

  protected openPlanting(parent: TreeNode | null): void {
    if (!this.canEdit()) return; // canvas "+" bud on a look-only visit
    this.plantedCount.set(0);
    this.newTitle.set('');
    this.sowText.set('');
    this.plantCadence.set(null); // «una vez» is always the fresh default
    this.burstFirstId = null;
    this.planting.set({ parent });
  }

  /** Closing the sheet after a real planting burst earns ONE gentle
   *  invitation to touch something — an offer, never a nag. */
  protected closePlanting(): void {
    const count = this.plantedCount();
    const firstId = this.burstFirstId;
    this.planting.set(null);
    // Never on a visit: a session would be the VISITOR'S, on a node that
    // lives in someone else's forest.
    if (count >= 6 && firstId && !this.burstInvited && !this.visit && !this.focus.active()) {
      this.burstInvited = true;
      this.toast.show({
        message: this.i18n.t().sow.burstInvite,
        actionLabel: this.i18n.t().whispers.tinyAction,
        action: () => void this.focus.start(firstId, 2),
      });
    }
  }

  /** «El ritmo» at plant time (0.0.103): null = una vez (default). */
  protected readonly plantCadence = signal<Cadence | null>(null);

  /** Planting is Enter-shaped (0.0.110, owner ask — the old v32 stay-open
   *  «name, Enter, name, Enter» law is RETIRED): one title, one commit, and
   *  the sheet closes so the new branch is the next thing you see. Planting
   *  several at once is exactly what «Varios a la vez» (sow) is for. */
  protected async plant(): Promise<void> {
    const tree = this.tree();
    const target = this.planting();
    const title = this.newTitle().trim();
    if (!tree || !target || !title) return;
    // «El corazón del árbol» (0.0.112): «+ Plantar aquí» grows a ramita of
    // the HEART — one trunk from here on («+ Plantar aquí» used to mint a
    // NEW root/trunk every time). Fallback null: a tree whose roots were
    // all archived grows a new heart. Legacy multi-root keeps rendering.
    // The parent is RE-READ at commit (0.0.115 M5): the sheet's snapshot
    // can outlive the branch — archived or pruned in another tab while the
    // title was being typed — and a ramita must never hang from a ghost.
    const parentId = this.liveParentId(target.parent, tree.id);
    let node: TreeNode;
    try {
      node = await this.nodes.plant(tree.id, parentId, {
        title,
        repeats: this.plantCadence() ?? undefined,
      });
    } catch (error) {
      if (this.capturePlanLimit(error)) return;
      throw error;
    }
    if (!tree.currentNodeId) await this.trees.setCurrentNode(tree, node.id);
    this.burstFirstId ??= node.id;
    this.newTitle.set('');
    this.plantedCount.update((c) => c + 1);
    this.closePlanting();
  }

  /** Brain-dump planting: every line sows a branch; leading tabs (or pairs
   *  of spaces) hang it from the nearest shallower line above. Paste-friendly. */
  protected async sow(): Promise<void> {
    const tree = this.tree();
    const target = this.planting();
    if (!tree || !target) return;
    const lines = this.sowText()
      .split('\n')
      .map((raw) => {
        const lead = raw.match(/^[\t ]*/)![0];
        const tabs = lead.split('\t').length - 1;
        const spacePairs = Math.floor(lead.replaceAll('\t', '').length / 2);
        return { depth: tabs + spacePairs, title: raw.trim() };
      })
      .filter((l) => l.title);
    if (!lines.length) return;

    const stack: { depth: number; node: TreeNode }[] = [];
    let count = 0;
    // Depth-0 lines hang from the heart too (0.0.112) — the sown plan is
    // the goal's first ramitas, not a row of new trunks. Same commit-time
    // re-read as plant() (0.0.115 M5).
    const baseParentId = this.liveParentId(target.parent, tree.id);
    try {
      this.nodes.assertCanPlant(tree.id, lines.length);
      for (const line of lines) {
        while (stack.length && stack[stack.length - 1].depth >= line.depth) stack.pop();
        const parentId = stack.length ? stack[stack.length - 1].node.id : baseParentId;
        const node = await this.nodes.plant(tree.id, parentId, { title: line.title });
        this.burstFirstId ??= node.id;
        stack.push({ depth: line.depth, node });
        count++;
      }
    } catch (error) {
      if (this.capturePlanLimit(error)) return;
      throw error;
    }
    const fresh = this.tree();
    if (fresh && !fresh.currentNodeId && this.burstFirstId) {
      const first = this.nodes.byId().get(this.burstFirstId);
      if (first) await this.trees.setCurrentNode(fresh, first.id);
    }
    this.sowText.set('');
    this.plantedCount.update((c) => c + count);
    // Sowing is ONE gesture (paste the plan, press Sembrar) — close the sheet
    // so the freshly-sprouted branches are the very next thing you see
    // (0.0.109, owner ask; since 0.0.110 plant() closes too). closePlanting()
    // runs AFTER the count update so the ≥6 burst invitation still fires.
    this.closePlanting();
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
    void this.router.navigate(['/account'], { queryParams: { redeem: 'access-key' } });
  }

  /** The commit-time parent: the sheet's captured branch only counts if it
   *  is still ALIVE (not archived, not pruned — cross-tab edits happen while
   *  the sheet is open); otherwise the heart adopts the planting, and a
   *  heartless tree grows a new trunk. */
  private liveParentId(captured: TreeNode | null, treeId: string): string | null {
    if (captured) {
      const fresh = this.nodes.byId().get(captured.id);
      if (fresh && !fresh.archivedAt && !fresh.deletedAt) return fresh.id;
    }
    return this.nodes.heartOf(treeId)?.id ?? null;
  }

  /** Tab indents inside the sowing box instead of walking focus away. */
  protected insertTab(el: HTMLInputElement | HTMLTextAreaElement): void {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + '\t' + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 1;
    this.sowText.set(el.value);
  }

  protected notFoundGoHome(): void {
    void this.router.navigate(this.backLink());
  }

  /** «La despedida» must not depend on the DOOR (0.0.107 — the 0.0.88
   *  status-picker lesson: same act, different control, different ceremony =
   *  predictability wound): archiving a FRUITED tree from its own page walks
   *  the same farewell as the meadow's 🗃. */
  private readonly harvests = inject(HarvestsRepo);
  private readonly conserveria = inject(ConserveriaService);
  protected readonly farewelling = signal(false);

  private boreFruit(): boolean {
    const tree = this.tree();
    return !!tree && this.harvests.all().some((h) => h.treeId === tree.id);
  }

  protected askArchive(): void {
    if (this.boreFruit()) this.farewelling.set(true);
    else this.archiving.set(true);
  }

  /** "Delete" the compass way: the tree rests in the archive, recoverable. */
  protected async archiveTree(): Promise<void> {
    const tree = this.tree();
    if (!tree) return;
    await this.trees.archive(tree);
    this.archiving.set(false);
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().tree.archivedToast, { name: tree.name }),
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.trees.restore(tree),
      },
      UNDO_MS,
    );
    void this.router.navigate(['/forest']);
  }

  /** Mirror of forest.keepFarewell: archive + distill in one gesture; undo
   *  restores the tree and removes the elixir. */
  protected async keepFarewell(carry: string): Promise<void> {
    const tree = this.tree();
    this.farewelling.set(false);
    if (!tree || tree.archivedAt) return;
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
    void this.router.navigate(['/forest']);
  }
}
