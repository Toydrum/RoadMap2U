import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { SessionsRepo } from '../../core/repos/sessions.repo';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { ESTIMATE_CHOICES, EstimateMin, Harvest, LIGHT_ICONS, LightChoice, NodePriority, NodeStatus, Tree, TreeNode } from '../../core/db/schema';
import { dayOf, isPast, today, weekdayOf } from '../../core/time';
import { Cadence, cadenceOf, isScheduledOn, nextScheduledAfter } from '../../core/cadence';
import { occurrenceRitual, ritualKind } from '../../core/harvest';
import { treeComplete } from '../../core/heart';
import { CadencePicker } from './cadence-picker';
import { SpiralGlyph } from '../forest/spiral';
import { HeartwoodGlyph } from '../forest/heartwood';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { RemindersService } from '../../core/reminders.service';
import { BloomBurstService } from '../../shared/ui/bloom-burst';
import { HarvestSkyService } from '../../shared/ui/harvest-sky';
import { flowerFor, fruitFor } from '../forest/flora';
import { BranchFlow } from './branch-flow';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { VisitSession } from '../../core/visit/visit-session';
import { PromiseService } from '../cosecha/promise.service';
import { forestQuotaMessage } from '../forest/forest-quota-feedback';
import { RitualCompletion, occurrenceAvailable } from './ritual-completion';

// Life-cycle order, rest LAST (owner 2026-07-11): seed → growing → bloomed
// reads as the branch's natural arc; resting is the aside, not a stage.
const SELECTABLE_STATUSES: NodeStatus[] = ['seed', 'growing', 'achieved', 'resting'];

// LightChoice + LIGHT_ICONS live in schema.ts (shared with the tablita).
const LIGHTS: LightChoice[] = ['sunlit', 'steady', 'shade'];

@Component({
  selector: 'app-node-detail',
  imports: [BranchFlow, CadencePicker, SpiralGlyph, HeartwoodGlyph, SheetDirective, ConfirmSheet],
  templateUrl: './node-detail.html',
  styleUrl: './node-detail.scss',
})
export class NodeDetail {
  protected readonly inputValue = inputValue;
  readonly node = input.required<TreeNode>();
  readonly tree = input.required<Tree>();
  readonly closed = output<void>();

  protected readonly i18n = inject(I18nService);
  protected readonly nodes = inject(NodesRepo);
  protected readonly trees = inject(TreesRepo);
  protected readonly sessions = inject(SessionsRepo);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly harvests = inject(HarvestsRepo);
  private readonly burst = inject(BloomBurstService);
  private readonly sky = inject(HarvestSkyService);
  private readonly promise = inject(PromiseService);
  private readonly reminders = inject(RemindersService);
  private readonly ritualCompletion = inject(RitualCompletion);

  protected readonly statuses = SELECTABLE_STATUSES;
  protected readonly lights = LIGHTS;
  protected readonly lightIcons = LIGHT_ICONS;
  /** «Brújula del tiempo» choices — null is «ni idea», a dignified answer. */
  protected readonly estimates = ESTIMATE_CHOICES;

  protected async setEstimate(minutes: EstimateMin | null): Promise<void> {
    // Re-tapping the selected chip clears back to «ni idea».
    const next = (this.node().estimateMin ?? null) === minutes ? null : minutes;
    await this.nodes.update(this.node(), { estimateMin: next });
  }

  protected estimateLabel(minutes: EstimateMin): string {
    const sizes = this.i18n.t().node.estimateSizes;
    switch (minutes) {
      case 60:
        return sizes.hour1;
      case 1440:
        return sizes.day1;
      case 10080:
        return sizes.week1;
      default:
        return minutes + ' ' + sizes.min;
    }
  }
  /** Sessions are the visitor's own — never offered inside someone else's forest. */
  protected readonly visiting = inject(VisitSession, { optional: true }) !== null;
  protected readonly branching = signal(false);
  protected readonly stepTitle = signal('');
  /** Briefly spotlights the next step after a bloom ("¿Siguiente paso?"). */
  protected readonly highlightId = signal<string | null>(null);
  private readonly stepInput = viewChild<ElementRef<HTMLInputElement>>('stepInput');
  /** Archiving takes the whole subtree with it — always ask first. */
  protected readonly confirmingArchive = signal(false);
  protected readonly confirmingRevert = signal(false);
  /** «Más detalles» fold — estimate + trigger live behind it. */
  protected readonly moreOpen = signal(false);

  /** The estimate editor only lives on live branches — the collapsed 🕐
   *  mark must promise exactly what expanding reveals (a stale estimate on
   *  an achieved/resting branch persists silently, but never advertises). */
  protected readonly estimateEditable = computed(() => {
    const status = this.node().status;
    return status === 'seed' || status === 'growing';
  });

  /** Every branch that would rest along with this one (self excluded). */
  protected readonly descendantCount = computed(() => {
    let count = 0;
    const queue = [...this.nodes.childrenOf(this.node())];
    while (queue.length) {
      const child = queue.pop()!;
      count++;
      queue.push(...this.nodes.childrenOf(child));
    }
    return count;
  });

  protected readonly children = computed(() => this.nodes.childrenOf(this.node()));

  /** 'steps' = the pasitos are an ordered path (paso 1 → paso 2 → …). */
  protected readonly flowSteps = computed(() => this.node().flow === 'steps');

  /** The earliest still-open step — "→ siguiente" on the ordered list. */
  protected readonly nextStepId = computed(
    () => this.children().find((c) => c.status === 'seed' || c.status === 'growing')?.id ?? null,
  );
  protected readonly datePassed = computed(() => {
    const date = this.node().targetDate;
    // A ritual's date is dead data (0.0.108) — no 🍂 while a cadence is set.
    return date !== null && isPast(date) && !this.cadence() && this.node().status !== 'achieved' && this.node().status !== 'branched';
  });
  protected readonly focusMinutes = computed(() => this.sessions.totalMinutesFor(this.node().id));
  protected readonly isCurrent = computed(() => this.tree().currentNodeId === this.node().id);

  /** Branch-born children still blank soil — revert stays honest. Once any
   *  alternative is touched, the transformation took root and this hides. */
  protected readonly revertable = computed(() => {
    const node = this.node();
    if (node.status !== 'branched') return false;
    return this.nodes
      .childrenOf(node)
      .filter((c) => c.origin === 'branch')
      .every(
        (c) =>
          c.status === 'seed' &&
          !c.note.trim() &&
          c.targetDate === null &&
          this.nodes.childrenOf(c).length === 0 &&
          !this.sessions.all().some((s) => s.nodeId === c.id),
      );
  });

  protected async setTitle(title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed && trimmed !== this.node().title) {
      await this.nodes.update(this.node(), { title: trimmed });
      // «El corazón ES el nombre del árbol» (0.0.112): renaming the heart
      // renames the tree — TreesRepo.rename finally has its caller.
      if (this.isHeart() && trimmed !== this.tree().name) {
        await this.trees.rename(this.tree(), trimmed);
      }
    }
  }

  /* ---------------------------------------- «el corazón del árbol» (0.0.112) */

  /** The tree's heart: its first visible root — the node born with the
   *  tree. A heart with ramitas is the goal's CENTER, not a task. */
  protected readonly isHeart = computed(() => this.nodes.heartOf(this.tree().id)?.id === this.node().id);

  /** The SLIM sheet applies to the CONTAINER heart only (≥1 ramita): a BARE
   *  heart is still the goal itself — full task sheet, pickable, bloomable
   *  (otherwise a one-node tree could never bloom at all). */
  protected readonly containerHeart = computed(() => this.isHeart() && this.children().length > 0);

  /** done/total over ALL visible descendants (recursive — must agree with
   *  treeComplete, or «5 de 5» could show without the door). */
  protected readonly heartStats = computed(() => {
    let done = 0;
    let total = 0;
    const stack = [...this.nodes.childrenOf(this.node())];
    const seen = new Set<string>();
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      total++;
      if (n.status === 'achieved' || n.status === 'branched') done++;
      stack.push(...this.nodes.childrenOf(n));
    }
    return { done, total };
  });

  protected readonly heartComplete = computed(() => {
    const heart = this.nodes.heartOf(this.tree().id);
    return !!heart && heart.id === this.node().id && this.isTreeComplete(heart);
  });

  private isTreeComplete(heart: TreeNode): boolean {
    return treeComplete(heart, (n) => this.nodes.childrenOf(n), this.nodes.rootsOf(heart.treeId));
  }

  protected heartLine(): string {
    const { done, total } = this.heartStats();
    // Pick the pair by hand: i18n.plural() consumes unknown placeholders
    // (it fills {count} and blanks the rest) — {done}/{total} must reach
    // fill() intact.
    const pair = this.i18n.t().node.heartLine;
    return this.i18n.fill(total === 1 ? pair.one : pair.many, { done, total });
  }

  /** Both doors land here: the last-bloom toast and the permanent button.
   *  The heart blooms ONLY this way (owner decision — no status picker on
   *  the center); everything built downstream fires on its own: the tree's
   *  fruit mints, the sky rains, the base flowers, the meadow gains one. */
  protected async bloomWholeTree(): Promise<void> {
    const heart = this.nodes.heartOf(this.tree().id);
    // Mirror of treeComplete's guards (branched has ONE exit: revertBranch)
    // — and never inside someone else's forest (closing a chapter is the
    // OWNER's act; a visitor's tap would also skip the fruit forever).
    if (this.visiting) return;
    if (!heart || !this.isTreeComplete(heart)) return;
    const prev = heart.status;
    const bloomed = await this.nodes.setStatus(heart, 'achieved');
    this.celebrateBloom(bloomed, null);
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().tree.bloomedWhole, { tree: this.tree().name }),
        actionLabel: this.i18n.t().common.undo,
        action: () => {
          // Re-read the live record (LWW law); reopening clears achievedAt —
          // the fruit STAYS in the pantry (nada se gasta).
          const fresh = this.nodes.byId().get(heart.id);
          if (fresh) void this.nodes.setStatus(fresh, prev);
        },
      },
      UNDO_MS,
    );
  }

  /** The offered door (never automatic — the 0.0.96 lesson): when the bloom
   *  that just landed completed the whole tree, ONE toast invites the close. */
  private maybeOfferTreeBloom(): void {
    if (this.visiting) return;
    const heart = this.nodes.heartOf(this.tree().id);
    if (!heart || heart.id === this.node().id) return;
    if (!this.isTreeComplete(heart)) return;
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().tree.bloomAsk, { tree: this.tree().name }),
        actionLabel: this.i18n.t().tree.bloomAction,
        action: () => void this.bloomWholeTree(),
        // Deliberately NOT `yields` (0.0.115): the door OWNS this rare,
        // culminating moment — the caller's own bloom toast and the jar ask
        // arrive right behind it and would displace a yielding door (D1).
        // Nothing undoable races it, and the heart's sheet keeps a
        // permanent door for whoever misses the toast.
      },
      12_000,
    );
  }

  protected async setNote(note: string): Promise<void> {
    if (note !== this.node().note) await this.nodes.update(this.node(), { note });
  }

  protected async setDate(value: string): Promise<void> {
    await this.nodes.update(this.node(), { targetDate: value || null });
  }

  /** «La campanita» (0.0.111): the hour is the opt-in gesture — ask for the
   *  notification permission right here (in-app toasts work regardless). */
  protected async setRemindAt(value: string): Promise<void> {
    const remindAt = value.trim() || null;
    if (remindAt === (this.node().remindAt ?? null)) return;
    await this.nodes.update(this.node(), { remindAt });
    if (remindAt) await this.reminders.ensurePermission();
  }

  protected async setTrigger(value: string): Promise<void> {
    const trigger = value.trim() || null;
    if (trigger !== (this.node().trigger ?? null)) {
      await this.nodes.update(this.node(), { trigger });
    }
  }

  /** The picker celebrates a bloom exactly like bloomStep does (0.0.88 —
   *  it used to be SILENT: the same act celebrated or not depending on
   *  which control was tapped, a predictability wound). The picker itself
   *  is the undo affordance, so the toast carries no action; reopening
   *  stays quiet. */
  protected async setStatus(status: NodeStatus, ev?: Event): Promise<void> {
    // Capture the anchor BEFORE any await — the DOM nulls currentTarget the
    // moment the synchronous dispatch ends (the burst anchored to nothing
    // for a day).
    const anchor = (ev?.currentTarget as Element) ?? null;
    const node = this.nodes.byId().get(this.node().id);
    if (!node || node.deletedAt || node.archivedAt || status === node.status) return;
    if (status === 'achieved' && occurrenceRitual(node, this.nodes.byId())) {
      return this.ritualCompletion.complete(this.nodes, this.trees, node.id, anchor);
    }
    const updated = await this.nodes.setStatus(node, status);
    if (status === 'achieved') {
      this.celebrateBloom(updated, anchor);
      this.toast.show({
        message: this.i18n.fill(this.i18n.t().ahora.bloomToast, { title: updated.title }),
      });
    }
  }

  /** Two celebration layers, one voice each (0.0.89): the ACT layer — the
   *  small petal burst at the tap point, every bloom, everywhere — and the
   *  HARVEST layer — the full-screen petal fall + the earned-fruit card,
   *  ONLY when a fruit actually mints (sendero pasitos return null; visits
   *  never mint — the sky never lies). The canvas fruit drop plays behind
   *  on its own status diff. */
  private celebrateBloom(node: TreeNode, anchor: Element | null): void {
    const species = flowerFor(this.tree().accent, this.tree().id);
    this.burst.burstAt(anchor, species);
    if (!this.visiting) {
      void this.harvests.recordBloom(node, this.tree(), this.nodes.byId()).then((minted) => {
        if (minted) {
          this.sky.celebrate(species, fruitFor(minted.accent, minted.treeId), minted.title);
          this.offerToStore(minted);
        }
      });
      // «El corazón del árbol» (0.0.112): if this bloom completed every
      // ramita, offer — never perform — the whole-tree bloom.
      this.maybeOfferTreeBloom();
    }
  }

  /** «La promesa» (0.0.93): right after a fruit mints, offer to store it in a
   *  goal jar (one tap for a single jar with space; the cross-page picker when
   *  more than one). Never during a visit — but recordBloom already gates that,
   *  so this only ever runs on the owner's own bloom. */
  private offerToStore(fruit: Harvest): void {
    if (this.visiting || fruit.preserveId) return;
    const jars = this.promise.acceptingFruit();
    if (!jars.length) return;
    if (jars.length === 1) {
      const jar = jars[0];
      this.toast.show(
        {
          message: this.i18n.fill(this.i18n.t().cosecha.promise.storeAsk, { name: jar.name }),
          actionLabel: this.i18n.t().cosecha.promise.storeAction,
          action: () => void this.promise.placeAndCelebrate(fruit.id, jar.id),
          yields: true, // an offer — the jar keeps accepting from la cosecha
        },
        UNDO_MS,
      );
    } else {
      this.toast.show(
        {
          message: this.i18n.t().cosecha.promise.storeChoose,
          actionLabel: this.i18n.t().cosecha.promise.storeChooseAction,
          action: () => this.promise.requestPlacement(fruit),
          yields: true, // an offer — the jar keeps accepting from la cosecha
        },
        UNDO_MS,
      );
    }
  }

  /** «La luz» lives only on live branches (seed/growing) — a stale value on
   *  an achieved/resting record persists silently and stays inert. */
  protected readonly currentLight = computed<LightChoice>(() => {
    const p = this.node().priority;
    return p === 'sunlit' || p === 'shade' ? p : 'steady';
  });

  protected async setLight(light: LightChoice): Promise<void> {
    if (light === this.currentLight()) return;
    const priority: NodePriority | null = light === 'steady' ? null : light;
    await this.nodes.update(this.node(), { priority });
  }

  protected async addStep(): Promise<void> {
    const title = this.stepTitle().trim();
    if (!title) return;
    try {
      await this.nodes.plant(this.node().treeId, this.node().id, { title });
    } catch (error) {
      this.showMutationError(error);
      return;
    }
    this.stepTitle.set('');
    // Clicking the + button steals focus — hand it back for the next step.
    this.stepInput()?.nativeElement.focus();
  }

  /* --------------------------- «desmenuzar» — the task-paralysis wizard */

  /** Three compass questions, one at a time; each non-empty answer becomes
   *  a pasito IN THE USER'S OWN WORDS (the cuando-entonces philosophy — no
   *  AI, no templates). Every question is skippable; skipping all three
   *  plants nothing and closes without a word. */
  protected readonly crumbleStep = signal<number | null>(null);
  protected readonly crumbleAnswer = signal('');
  protected readonly crumbleSaving = signal(false);
  private crumbleAnswers: string[] = [];

  /** Offered while the branch is live and still standing bare (≤1 pasito). */
  protected readonly canCrumble = computed(() => {
    const status = this.node().status;
    return (status === 'seed' || status === 'growing') && this.children().length <= 1;
  });

  protected startCrumble(): void {
    if (this.crumbleSaving()) return;
    this.crumbleAnswers = [];
    this.crumbleAnswer.set('');
    this.crumbleStep.set(0);
  }

  protected async crumbleNext(skip: boolean): Promise<void> {
    const step = this.crumbleStep();
    if (step === null || this.crumbleSaving()) return;
    const answer = skip ? '' : this.crumbleAnswer().trim();
    if (step < 2) {
      if (answer) this.crumbleAnswers.push(answer);
      this.crumbleAnswer.set('');
      this.crumbleStep.set(step + 1);
      return;
    }
    const node = this.node();
    const drafts = [...this.crumbleAnswers, answer].filter(Boolean).map((title) => ({ parentId: node.id, title }));
    if (!drafts.length) {
      this.closeCrumble();
      return;
    }
    this.crumbleSaving.set(true);
    try {
      await this.nodes.plantMany(node.treeId, drafts);
      this.closeCrumble();
      this.toast.show({
        message: this.i18n.plural(drafts.length, this.i18n.t().crumble.planted),
      });
    } catch (error) {
      this.showMutationError(error);
    } finally {
      this.crumbleSaving.set(false);
    }
  }

  protected closeCrumble(): void {
    this.crumbleStep.set(null);
    this.crumbleAnswer.set('');
    this.crumbleAnswers = [];
  }

  /** The pasitos become (or stop being) an ordered path. Never forced. */
  protected async toggleFlow(): Promise<void> {
    await this.nodes.update(this.node(), { flow: this.flowSteps() ? 'free' : 'steps' });
  }

  /** «El ritmo» (0.0.103): the branch's cadence, read ONLY via cadenceOf. */
  protected readonly cadence = computed(() => cadenceOf(this.node()));

  /** «Un ritual no se desmenuza» (0.0.104, owner rule): a ritual LEAF is a
   *  small act that repeats — the Pasitos section and Desmenuzar hide. */
  protected readonly isRitualLeaf = computed(() => ritualKind(this.node()) === 'leaf');

  protected occurrenceBlocked(node: TreeNode): boolean {
    const ritual = occurrenceRitual(node, this.nodes.byId());
    return !!ritual && (node.status === 'resting' || !occurrenceAvailable(node, ritual, today()));
  }

  protected readonly ritualRestLine = computed(() => {
    const node = this.node();
    const ritual = occurrenceRitual(node, this.nodes.byId());
    const cadence = ritual && cadenceOf(ritual);
    const day = today();
    if (!cadence || isScheduledOn(cadence, day)) return '';
    const next = nextScheduledAfter(cadence, day);
    if (!next) return '';
    const dict = this.i18n.t();
    return this.i18n.fill(dict.almanaque.restingOne, {
      title: ritual.title,
      day: dict.cadence.weekdayNames[weekdayOf(next)],
    });
  });

  /** The rhythm in words for the header chip — «Cada día», «L J», «Cada semana». */
  protected cadenceWords(): string {
    const c = this.cadence();
    if (!c) return '';
    const dict = this.i18n.t().cadence;
    if (c === 'daily') return dict.daily;
    if (c === 'weekly') return dict.weekly;
    return c.map((d) => dict.weekdayLetters[d]).join(' ');
  }

  /** Toggle on = daily by default; toggle off = clearing the rhythm (a
   *  ritual leaf RETIRES this way — its standing bloom then mints). Every
   *  cadence write mirrors the repeatsDaily compat shadow. */
  protected async toggleRepeats(): Promise<void> {
    await this.setCadence(this.cadence() ? null : 'daily');
  }

  /** «La historia se queda» (0.0.106): giving a rhythm to a leaf that
   *  bloomed on an EARLIER day would leave a flower reading «done today»
   *  forever — waking it (re-seed, fruit kept) is part of the choice, so
   *  the door asks first. Same-day blooms are the ritual's first period. */
  protected readonly confirmingWake = signal<Cadence | null>(null);

  protected async setCadence(c: Cadence | null): Promise<void> {
    const n = this.node();
    const needsWake =
      c != null &&
      !cadenceOf(n) &&
      n.flow !== 'steps' &&
      n.status === 'achieved' &&
      n.achievedAt != null &&
      dayOf(n.achievedAt) < today();
    if (needsWake) {
      this.confirmingWake.set(c);
      return;
    }
    await this.nodes.setCadence(n, c);
  }

  protected async confirmWake(): Promise<void> {
    const c = this.confirmingWake();
    this.confirmingWake.set(null);
    if (c) await this.nodes.setCadence(this.node(), c, true);
  }

  protected async moveStep(child: TreeNode, dir: -1 | 1): Promise<void> {
    await this.nodes.moveStep(child, dir);
  }

  /** Blooming a pasito is an unambiguous "done!" — celebrate it and offer
   *  the next move right at the dopamine peak: on an ordered path that is
   *  the NEXT step; otherwise, planting another tiny one. */
  protected async bloomStep(child: TreeNode, ev?: Event): Promise<void> {
    const anchor = (ev?.currentTarget as Element) ?? null;
    if (occurrenceRitual(child, this.nodes.byId())) {
      return this.ritualCompletion.complete(this.nodes, this.trees, child.id, anchor);
    }
    await this.nodes.setStatus(child, 'achieved');
    this.celebrateBloom(child, anchor);
    const next = this.flowSteps()
      ? this.children().find((c) => c.status === 'seed' || c.status === 'growing')
      : null;
    this.toast.show({
      message: this.i18n.fill(this.i18n.t().ahora.bloomToast, { title: child.title }),
      actionLabel: next ? this.i18n.t().node.nextStepAction : this.i18n.t().ahora.bloomMore,
      action: () => {
        if (next) {
          this.highlightId.set(next.id);
          document.getElementById('step-' + next.id)?.scrollIntoView({ block: 'nearest' });
          setTimeout(() => this.highlightId.set(null), 2600);
        } else {
          this.stepInput()?.nativeElement.focus();
        }
      },
    });
  }

  protected async setHere(): Promise<void> {
    await this.trees.setCurrentNode(this.tree(), this.node().id);
  }

  protected focusHere(): void {
    void this.router.navigate(['/timer'], { queryParams: { node: this.node().id } });
  }

  /** Body for the archive confirm — the subtree count folds into the text. */
  protected archiveBodyText(): string {
    const base = this.i18n.t().node.archiveNodeBody;
    return this.descendantCount() > 0
      ? base + ' ' + this.i18n.plural(this.descendantCount(), this.i18n.t().node.archiveNodeChildren)
      : base;
  }

  protected async archive(): Promise<void> {
    const node = this.node();
    const archived = await this.nodes.archiveSubtree(node);
    this.confirmingArchive.set(false);
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().node.archivedToast, { title: node.title }),
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.nodes.unarchiveMany(archived).catch((error) => this.showMutationError(error)),
      },
      UNDO_MS,
    );
    this.closed.emit();
  }

  private showMutationError(error: unknown): void {
    this.toast.show({
      message: forestQuotaMessage(this.i18n, error) ?? this.i18n.t().familia.errors.unknown,
    });
  }

  /** Undo of an unrooted branching — the only way out of 'branched'. */
  protected async revertBranch(): Promise<void> {
    const node = this.node();
    const removed = await this.nodes.revertBranch(node);
    if (removed.some((c) => c.id === this.tree().currentNodeId)) {
      await this.trees.setCurrentNode(this.tree(), node.id);
    }
    this.confirmingRevert.set(false);
    this.toast.show({ message: this.i18n.t().node.revertedToast });
  }

  protected plantedOn(): string {
    return new Date(this.node().createdAt).toLocaleDateString(this.i18n.lang() === 'es' ? 'es-MX' : 'en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
