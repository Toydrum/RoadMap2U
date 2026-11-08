import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { BloomBurstService } from '../../shared/ui/bloom-burst';
import { FEELING_EMOJI, Tree, TreeNode } from '../../core/db/schema';
import { dayOf, today, weekdayOf } from '../../core/time';
import { Cadence } from '../../core/cadence';
import { inputValue } from '../../shared/ui/dom';
import { SheetDirective } from '../../shared/ui/sheet.directive';
import { CadencePicker } from '../node-detail/cadence-picker';
import { SpiralGlyph } from '../forest/spiral';
import { hash } from '../forest/tree-layout';
import { FlowerSpec, flowerFor } from '../forest/flora';
import { FlowerGlyph } from '../forest/flower';
import { forestQuotaMessage } from '../forest/forest-quota-feedback';
import { DateReview } from '../check-in/date-review';
import { HintChip } from '../../shared/ui/hint-chip';
import {
  Caminito,
  DatedBranch,
  DayChip,
  DayMarks,
  Piedrita,
  RestingRitual,
  caminitos,
  dayChips,
  descansanHoy,
  marksFor,
  monthMatrix,
  piedritas,
  todayDated,
  upcoming,
} from './almanac';

/** What one grid cell paints (at most two glyphs; the rest fold into (N)). */
interface CellGlyph {
  kind: 'flower' | 'knot' | 'capullo';
  spec: FlowerSpec;
}

/**
 * «El almanaque» — the forest seen through days. A TIME LENS over data
 * that already exists, sister of the tablita: it mirrors, it never
 * schedules and it never suggests (Ahora keeps that job). The past shows
 * only what grew; empty days are barbecho, never blanks in a scorecard.
 */
@Component({
  selector: 'app-almanaque',
  imports: [RouterLink, FlowerGlyph, SpiralGlyph, DateReview, HintChip, SheetDirective, CadencePicker],
  templateUrl: './almanaque.html',
  styleUrl: './almanaque.scss',
})
export class AlmanaquePage {
  protected readonly i18n = inject(I18nService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);

  /** Wide mode (the app's FIRST min-width consumer): titled chips replace
   *  the glyph marks when cells have room. Extract to a service only when
   *  a second consumer appears. */
  protected readonly wide = signal(
    typeof matchMedia !== 'undefined' && matchMedia('(min-width: 720px)').matches,
  );

  constructor() {
    if (typeof matchMedia !== 'undefined') {
      const mq = matchMedia('(min-width: 720px)');
      const onChange = (e: MediaQueryListEvent) => this.wide.set(e.matches);
      mq.addEventListener('change', onChange);
      this.destroyRef.onDestroy(() => mq.removeEventListener('change', onChange));
    }
    // ?day=YYYY-MM-DD deep link (reserved for the future week strip too).
    // Round-trip validated (0.0.115 M6): the shape regex alone let
    // «2026-99-99» open a phantom panel over a month that never shows it.
    // A real day from ANOTHER month also pins the calendar to that month —
    // otherwise the panel talks about a day the grid isn't showing.
    const day = this.route.snapshot.queryParamMap.get('day');
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const [y, m, d] = day.split('-').map(Number);
      const date = new Date(y, m - 1, d, 12);
      if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) {
        this.openDate.set(day);
        if (day.slice(0, 7) !== today().slice(0, 7)) this.view.set({ y, m });
      }
    }
  }
  protected readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly checkins = inject(CheckinsRepo);
  private readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);
  private readonly burst = inject(BloomBurstService);
  private readonly router = inject(Router);

  /* ------------------------------------------------------------- Hoy -- */

  protected readonly todayKey = computed(() => today());

  protected readonly todayLine = computed(() => {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const [y, m, d] = today().split('-').map(Number);
    const date = new Date(y, m - 1, d, 12).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    return this.i18n.fill(this.i18n.t().almanaque.todayIs, { date });
  });

  protected readonly paths = computed<Caminito[]>(() =>
    caminitos(this.trees.active(), this.nodes.byTree(), today()),
  );

  /** Today's loose stones — single-act rituals (0.0.103). */
  protected readonly stones = computed<Piedrita[]>(() =>
    piedritas(this.trees.active(), this.nodes.byTree(), today()),
  );

  /** Rituals off their day — the gentle rest line. */
  protected readonly restingToday = computed<RestingRitual[]>(() =>
    descansanHoy(this.trees.active(), this.nodes.byTree(), today()),
  );

  /** Today's chosen branches — silently empty once the date moves on. */
  protected readonly todayChips = computed<TreeNode[]>(() => {
    const intentions = this.settings.settings().todayIntentions;
    if (!intentions || intentions.date !== today()) return [];
    const activeIds = new Set(this.trees.active().map((t) => t.id));
    return intentions.nodeIds
      .map((id) => this.nodes.byId().get(id))
      .filter((n): n is TreeNode => !!n && !n.deletedAt && !n.archivedAt && activeIds.has(n.treeId));
  });

  protected readonly pendingReviews = computed(() => {
    const activeIds = new Set(this.trees.active().map((t) => t.id));
    return this.nodes.needsDateReview().filter((n) => activeIds.has(n.treeId));
  });

  protected readonly reviewing = signal(false);

  protected readonly upcomingDates = computed(() =>
    upcoming(this.trees.active(), this.nodes.byTree(), today()),
  );

  /** Fechas amables landing exactly TODAY — the Hoy section's own list. */
  protected readonly todayDatedRows = computed<DatedBranch[]>(() =>
    todayDated(this.trees.active(), this.nodes.byTree(), today()),
  );

  protected upcomingText(entry: { node: TreeNode; when: string }): string {
    const dict = this.i18n.t().almanaque;
    const when =
      entry.when === 'tomorrow'
        ? dict.whenTomorrow
        : entry.when === 'days'
          ? dict.whenDays
          : entry.when === 'week'
            ? dict.whenWeek
            : dict.whenLater;
    return this.i18n.fill(dict.upcomingLine, { title: entry.node.title, when });
  }

  protected readonly todayIsQuiet = computed(
    () =>
      !this.paths().length &&
      !this.todayChips().length &&
      !this.todayDatedRows().length &&
      !this.upcomingDates().length &&
      !this.pendingReviews().length,
  );

  /** Bloom the «siguiente» stone right on the path — same verb as the tree,
   *  with the undo law (re-read the LIVE record; never re-save a capture). */
  private bloomingStone = false;

  protected async bloomStone(step: TreeNode, ev?: Event): Promise<void> {
    // Anchor captured before the await — currentTarget nulls after dispatch.
    const anchor = (ev?.currentTarget as Element) ?? null;
    if (this.bloomingStone) return;
    const live = this.nodes.byId().get(step.id);
    // archivedAt too (0.0.115 B1): a stone archived in another tab while
    // this list was on screen must not bloom into an invisible drawer.
    if (!live || live.deletedAt || live.archivedAt || live.status === 'achieved') return;
    this.bloomingStone = true;
    const prevStatus = live.status;
    try {
      await this.nodes.setStatus(live, 'achieved');
    } finally {
      this.bloomingStone = false;
    }
    // «El estallido» celebrates the ACT (equal dignity — senderos too);
    // fruit stays out: stones are sendero pasitos and the jar never lies.
    const tree = this.trees.byId().get(step.treeId);
    if (tree) {
      this.burst.burstAt(anchor, flowerFor(tree.accent, tree.id));
    }
    this.toast.show(
      {
        message: this.i18n.fill(this.i18n.t().almanaque.stoneBloomed, { title: step.title }),
        actionLabel: this.i18n.t().common.undo,
        action: () => {
          const fresh = this.nodes.byId().get(step.id);
          if (fresh && !fresh.deletedAt && fresh.status === 'achieved') {
            void this.nodes.setStatus(fresh, prevStatus);
          }
        },
      },
      UNDO_MS,
    );
  }

  /* ------------------------------------- Sembrar una piedrita (0.0.103) */

  protected readonly inputValue = inputValue;
  protected readonly sowingStone = signal(false);
  protected readonly stoneTitle = signal('');
  protected readonly stoneTreeId = signal<string | null>(null);
  protected readonly stoneTree = computed(() =>
    this.trees.active().find((tree) => tree.id === this.stoneTreeId()),
  );
  protected readonly stoneCadence = signal<Cadence>('daily');
  protected readonly stoneSaving = signal(false);
  protected readonly stoneError = signal('');

  protected openSowing(): void {
    // Default tree = the first standing one — always a VISIBLE picker choice.
    this.stoneTreeId.set(this.trees.active()[0]?.id ?? null);
    this.sowingStone.set(true);
  }

  protected closeSowing(): void {
    if (this.stoneSaving()) return;
    this.sowingStone.set(false);
    this.stoneTitle.set('');
    this.stoneCadence.set('daily');
    this.stoneError.set('');
  }

  /** Plant a ritual leaf in the USER-PICKED tree (top level). The compat
   *  shadow travels with it (nodes.plant mirrors repeatsDaily). */
  protected async sowStone(): Promise<void> {
    const title = this.stoneTitle().trim();
    const tree = this.stoneTree();
    if (!title || !tree || this.stoneSaving()) return;
    this.stoneSaving.set(true);
    this.stoneError.set('');
    try {
      await this.nodes.plant(tree.id, null, { title, repeats: this.stoneCadence() });
    } catch (error) {
      this.stoneError.set(
        forestQuotaMessage(this.i18n, error) ?? this.i18n.t().almanaque.piedritaSaveError,
      );
      return;
    } finally {
      this.stoneSaving.set(false);
    }
    this.toast.show({ message: this.i18n.fill(this.i18n.t().almanaque.piedritaSown, { title }) });
    this.closeSowing();
  }

  /** The gentle rest line: words, never countdowns. Singular names the day
   *  («vuelve el jueves»); several fold into one calm sentence. */
  protected restingLine(): string {
    const resting = this.restingToday();
    const dict = this.i18n.t().almanaque;
    if (resting.length === 1) {
      const r = resting[0];
      const day = this.i18n.t().cadence.weekdayNames[weekdayOf(r.nextDay)];
      return this.i18n.fill(dict.restingOne, { title: r.node.title, day });
    }
    return this.i18n.fill(dict.restingMany, { names: resting.map((r) => r.node.title).join(', ') });
  }

  /* ------------------------------------------------------------- Mes -- */

  /** null = follow today (so a midnight month-flip moves the grid too);
   *  set only by explicit ‹ › navigation. */
  private readonly view = signal<{ y: number; m: number } | null>(null);

  private readonly viewYM = computed(() => {
    const pinned = this.view();
    if (pinned) return pinned;
    return { y: Number(today().slice(0, 4)), m: Number(today().slice(5, 7)) };
  });

  protected readonly weeks = computed(() =>
    monthMatrix(this.viewYM().y, this.viewYM().m, this.i18n.lang() === 'en' ? 0 : 1),
  );

  protected readonly monthLabel = computed(() => {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const label = new Date(this.viewYM().y, this.viewYM().m - 1, 1, 12).toLocaleDateString(locale, {
      month: 'long',
      year: 'numeric',
    });
    return label.charAt(0).toUpperCase() + label.slice(1);
  });

  protected readonly weekdayNames = computed(() => {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const start = this.i18n.lang() === 'en' ? 0 : 1;
    // A known week: 2026-06-01 was a Monday; day 7 = Sunday.
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(2026, 5, 1 + ((start + i + 6) % 7), 12);
      return day.toLocaleDateString(locale, { weekday: 'narrow' });
    });
  });

  protected readonly marks = computed(() =>
    marksFor(this.trees.active(), this.nodes.byTree(), this.checkins.all(), today()),
  );

  protected readonly viewingToday = computed(() => {
    const ym = this.viewYM();
    return ym.y === Number(today().slice(0, 4)) && ym.m === Number(today().slice(5, 7));
  });

  protected prevMonth(): void {
    const { y, m } = this.viewYM();
    this.view.set(m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 });
    // The day panel closes when its month scrolls away (0.0.115 B2) —
    // an open panel narrating a day the grid no longer shows disorients.
    this.openDate.set(null);
  }

  protected nextMonth(): void {
    const { y, m } = this.viewYM();
    this.view.set(m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
    this.openDate.set(null);
  }

  protected backToToday(): void {
    this.view.set(null);
  }

  /* ------------------------------------------------- cell rendering -- */

  protected dayNum(date: string): number {
    return Number(date.slice(8, 10));
  }

  /** Localized long form of a date key — cell aria + the day page title. */
  protected dateLine(date: string): string {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, 12).toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  /** Deterministic soil-plot wobble — same day, same little shape, forever. */
  protected wobble(date: string): string {
    const h = hash(date);
    const r = (shift: number) => 6 + ((h >> shift) % 7);
    return `${r(0)}px ${r(3)}px ${r(6)}px ${r(9)}px`;
  }

  /** ONE priority order for both renderings (pure: almanac.dayChips). */
  protected cellChips(m: DayMarks): DayChip[] {
    return dayChips(m, this.wide() ? 3 : 2);
  }

  /** Narrow mode keeps the 0.0.85 glyph svg — same chips, first two. */
  protected cellGlyphs(m: DayMarks): CellGlyph[] {
    return dayChips(m, 2).map((c) => ({ kind: c.kind, spec: this.specOf(c.tree) }));
  }

  protected overflowCount(m: DayMarks): number {
    const total = m.flowers.length + m.knots.length + m.capullos.length;
    return Math.max(0, total - (this.wide() ? 3 : 2));
  }

  /** The tree-pairing wash — categorical, NEVER count-scaled (anti-heatmap). */
  protected chipWash(chip: DayChip): string {
    if (chip.kind === 'knot') {
      return 'color-mix(in srgb, var(--status-branched) 12%, var(--surface))';
    }
    return `color-mix(in srgb, var(--accent-${chip.tree.accent}) 14%, var(--surface))`;
  }

  protected chipBorder(chip: DayChip): string {
    if (chip.kind === 'knot') {
      return 'color-mix(in srgb, var(--status-branched) 32%, var(--border))';
    }
    return `color-mix(in srgb, var(--accent-${chip.tree.accent}) 32%, var(--border))`;
  }

  /** Wide cells speak their titles to the screen reader via the button. */
  protected cellLabel(date: string, m: DayMarks | undefined): string {
    const line = this.dateLine(date);
    if (!m || !this.wide()) return line;
    const titles = dayChips(m, 3).map((c) => c.node.title).join(', ');
    return titles ? `${line}: ${titles}` : line;
  }

  protected hasPassedDate(m: DayMarks): boolean {
    return m.capullos.some((c) => c.passed);
  }

  /** A steady species for the legend art (moss classic — deterministic). */
  protected readonly legendSpec: FlowerSpec = flowerFor('moss');

  private readonly specCache = new Map<string, FlowerSpec>();

  protected specOf(tree: Tree): FlowerSpec {
    let spec = this.specCache.get(tree.id);
    if (!spec) {
      spec = flowerFor(tree.accent, tree.id);
      this.specCache.set(tree.id, spec);
    }
    return spec;
  }

  /** Arrow keys walk the grid — roving focus, calm and predictable. */
  protected onGridKey(event: KeyboardEvent): void {
    const deltas: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };
    const delta = deltas[event.key];
    if (!delta) return;
    const cells = Array.from(
      (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('.alm-cell:not(.out)'),
    );
    const index = cells.indexOf(event.target as HTMLButtonElement);
    if (index === -1) return;
    const next = cells[index + delta];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  /* -------------------------------------------------- day page sheet -- */

  protected readonly openDate = signal<string | null>(null);

  protected readonly openMarks = computed<DayMarks | null>(() => {
    const date = this.openDate();
    if (!date) return null;
    return (
      this.marks().get(date) ?? { capullos: [], flowers: [], knots: [], hasCheckin: false }
    );
  });

  protected readonly openDateLine = computed(() => {
    const date = this.openDate();
    return date ? this.dateLine(date) : '';
  });

  /** That day's footprints — feeling + notita, trail-style, day-scoped. */
  protected readonly openFootprints = computed(() => {
    const date = this.openDate();
    if (!date) return [];
    const dict = this.i18n.t();
    return this.checkins
      .all()
      .filter((c) => dayOf(c.createdAt) === date)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c) => ({
        emoji: FEELING_EMOJI[c.feeling],
        feelingName: dict.checkIn.feelings[c.feeling],
        note: c.note.trim(),
      }));
  });

  protected readonly openIsPast = computed(() => (this.openDate() ?? '') < today());
  protected readonly openIsToday = computed(() => this.openDate() === today());

  protected readonly openIsEmpty = computed(() => {
    const m = this.openMarks();
    return (
      !!m && !m.capullos.length && !m.flowers.length && !m.knots.length && !this.openFootprints().length
    );
  });

  /** Disclosure, not dialog: second tap on the same day closes. */
  protected openDay(date: string): void {
    if (this.openDate() === date) {
      this.openDate.set(null);
      return;
    }
    this.openDate.set(date);
    setTimeout(() => {
      document
        .getElementById('alm-day-panel')
        ?.scrollIntoView({ block: 'nearest', behavior: this.motionReduced() ? 'auto' : 'smooth' });
    }, 60);
  }

  private motionReduced(): boolean {
    return document.documentElement.classList.contains('reduce-motion');
  }

  protected closeDay(): void {
    this.openDate.set(null);
  }

  /** Escape closes the panel and hands focus back to the selected cell.
   *  Bound on the month section (NOT document) — it must never race the
   *  date-review sheet's appSheet Escape stack. */
  protected onMesEscape(): void {
    const date = this.openDate();
    if (!date) return;
    this.openDate.set(null);
    const cell = document.querySelector<HTMLButtonElement>(`.alm-cell[data-date="${date}"]`);
    cell?.focus();
  }

  protected treeOf(node: TreeNode): Tree | undefined {
    return this.trees.byId().get(node.treeId);
  }

  /** Every deep tap lands on the tree — the almanac never replaces it. */
  protected openBranch(node: TreeNode): void {
    this.openDate.set(null);
    void this.router.navigate(['/tree', node.treeId], { queryParams: { node: node.id } });
  }

}
