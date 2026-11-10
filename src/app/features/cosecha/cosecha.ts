import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { Location } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { PreservesRepo } from '../../core/repos/preserves.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { ConserveriaService } from '../../core/conserveria.service';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';
import { Harvest, Preserve } from '../../core/db/schema';
import { harvestMonths, isElixir, isPending, isSealedJam } from '../../core/harvest';
import { FruitSpec, fruitFor } from '../forest/flora';
import { FruitGlyph } from '../forest/fruit';
import { MeadowJar } from '../forest/jar';
import { JamJar } from '../forest/jam-jar';
import { PromiseJar } from '../forest/promise-jar';
import { ElixirVial } from '../forest/elixir-vial';
import { HintChip } from '../../shared/ui/hint-chip';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { MermeladaSheet } from './mermelada-sheet';
import { AbrirMermeladaSheet } from './abrir-mermelada-sheet';
import { PromesaSheet } from './promesa-sheet';
import { HacerMermeladaSheet } from './hacer-mermelada-sheet';
import { JarDetail } from './jar-detail';
import { PromiseService } from './promise.service';

interface HarvestRow {
  harvest: Harvest;
  spec: FruitSpec;
  /** «el 12 de julio» — a memory's date, never an elapsed-time age. */
  when: string;
  /** Door back to the branch — only while it still stands visible. */
  live: boolean;
  /** The jar this fruit lives in (single-home made visible), or null. */
  jarName: string | null;
}

interface JamShelfItem {
  preserve: Preserve;
  monthWord: string;
}

/**
 * «La conservería» (0.0.89) — the pantry page: the fresh jar, the shelves
 * (filling / sealed / enjoyed), the ritual doors, and the month REGISTER
 * (every fruit forever — the lifetime count can never decrease; monotonicity
 * is the visible proof nothing is ever spent). Master law: nada se gasta; todo
 * se conserva. 0.0.94 «la cocina despejada»: ONE jar-detail component + ONE
 * `openId` (a single panel open at a time) replaced the two parallel panels.
 */
@Component({
  selector: 'app-cosecha',
  imports: [
    RouterLink,
    FruitGlyph,
    MeadowJar,
    JamJar,
    PromiseJar,
    ElixirVial,
    JarDetail,
    HintChip,
    ConfirmSheet,
    MermeladaSheet,
    AbrirMermeladaSheet,
    PromesaSheet,
    HacerMermeladaSheet,
  ],
  templateUrl: './cosecha.html',
  styleUrl: './cosecha.scss',
})
export class CosechaPage {
  protected readonly i18n = inject(I18nService);
  protected readonly harvests = inject(HarvestsRepo);
  protected readonly preserves = inject(PreservesRepo);
  protected readonly promise = inject(PromiseService);
  private readonly nodes = inject(NodesRepo);
  private readonly conserveria = inject(ConserveriaService);
  private readonly toast = inject(ToastService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly pendingDetail = viewChild<JarDetail>('pendingDetail');

  /** Ritual doors — @defer'd sheets; DOORS CANCEL applies to all. */
  protected readonly makingJam = signal(false);
  /** «La promesa» wizard door. */
  protected readonly promising = signal(false);
  /** The claiming ceremony's jar («abrir la mermelada»), or null. */
  protected readonly claiming = signal<Preserve | null>(null);
  /** THE inline disclosure — one jar open at a time across all three shelves
   *  (0.0.94: replaced the separate openJarId/openPendingId). */
  protected readonly openId = signal<string | null>(null);
  /** The pending jar awaiting a «soltar» confirm, or null. */
  protected readonly releasing = signal<Preserve | null>(null);
  /** A full goal jar being MADE into jam (the cook ceremony), or null. */
  protected readonly making = signal<Preserve | null>(null);

  /** 0.0.100 «la alacena respira» — the HISTORY shelves fold by default
   *  (session lenses, tablita-style; the (N) is a utility fold count, never a
   *  celebration). The living shelves (pending, alacena) never fold. */
  protected readonly enjoyedOpen = signal(false);
  protected readonly farewellsOpen = signal(false);
  /** Register months: the FIRST (most recent) opens by default; the rest fold.
   *  XOR lens — a toggled key flips its default state, no seeding effect. */
  private readonly toggledMonths = signal<ReadonlySet<string>>(new Set());

  protected monthOpen(key: string, index: number): boolean {
    return (index === 0) !== this.toggledMonths().has(key);
  }

  protected toggleMonth(key: string): void {
    const next = new Set(this.toggledMonths());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.toggledMonths.set(next);
  }

  /** Folding a history shelf closes its own open panel (never an orphan). */
  protected toggleEnjoyed(): void {
    const open = !this.enjoyedOpen();
    this.enjoyedOpen.set(open);
    if (!open && this.openInDisfrutadas()) this.openId.set(null);
  }

  protected toggleFarewells(): void {
    const open = !this.farewellsOpen();
    this.farewellsOpen.set(open);
    if (!open && this.openInElixir()) this.openId.set(null);
  }

  private monthWordOf(epochMs: number): string {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const d = new Date(epochMs);
    const thisYear = new Date().getFullYear();
    return d.getFullYear() === thisYear
      ? d.toLocaleDateString(locale, { month: 'long' })
      : d.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  }

  private rowOf(harvest: Harvest): HarvestRow {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const node = this.nodes.byId().get(harvest.nodeId);
    const jar = harvest.preserveId ? this.preserves.byId().get(harvest.preserveId) : undefined;
    return {
      harvest,
      spec: fruitFor(harvest.accent, harvest.treeId),
      when: new Date(harvest.harvestedAt).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
      }),
      live: !!node && !node.deletedAt && !node.archivedAt,
      jarName: jar && !jar.deletedAt ? jar.name : null,
    };
  }

  /** The REGISTER: month shelves over every fruit, whatever its home. */
  protected readonly shelves = computed(() =>
    harvestMonths(this.harvests.all()).map((month) => {
      const [y, m] = month.key.split('-').map(Number);
      return {
        key: month.key,
        monthWord: this.monthWordOf(new Date(y, m - 1, 1).getTime()),
        rows: month.items.map((h) => this.rowOf(h)),
      };
    }),
  );

  private shelfItemOf(preserve: Preserve): JamShelfItem {
    return { preserve, monthWord: this.monthWordOf(preserve.madeAt) };
  }

  /** The alacena: SEALED jars only (0.0.92 — the shelf of what waits),
   *  chronological. Pending goal jars have their own shelf (isSealedJam). */
  protected readonly jamShelf = computed<JamShelfItem[]>(() =>
    this.preserves
      .newestFirst()
      .filter((p) => !isElixir(p) && isSealedJam(p) && !p.openedAt)
      .map((p) => this.shelfItemOf(p)),
  );

  /** «Las disfrutadas» (0.0.92): opened JAMS move HERE — history, never
   *  deletion; still tappable, memories forever, newest enjoyment first.
   *  (Elixirs stay on their own «Las despedidas» shelf even when drunk.) */
  protected readonly enjoyedShelf = computed<JamShelfItem[]>(() =>
    this.preserves
      .newestFirst()
      .filter((p) => !isElixir(p) && !!p.openedAt)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || (a.id < b.id ? -1 : 1))
      .map((p) => this.shelfItemOf(p)),
  );

  /** «Las despedidas» (0.0.95): elixir vials (drunk and un-drunk). */
  protected readonly elixirShelf = computed<JamShelfItem[]>(() =>
    this.preserves.elixirs().map((p) => this.shelfItemOf(p)),
  );

  /** The one open jar (live), whatever shelf it belongs to. */
  private readonly openPreserve = computed(() => {
    const id = this.openId();
    if (!id) return null;
    const p = this.preserves.byId().get(id);
    return p && !p.deletedAt ? p : null;
  });

  /** Per-shelf slots — only the shelf the open jar belongs to shows the panel,
   *  which keeps the «expands under its shelf» feel with a single openId. */
  protected readonly openInPending = computed(() => {
    const p = this.openPreserve();
    return p && isPending(p) ? p : null;
  });
  protected readonly openInAlacena = computed(() => {
    const p = this.openPreserve();
    return p && !isElixir(p) && isSealedJam(p) && !p.openedAt ? p : null;
  });
  protected readonly openInDisfrutadas = computed(() => {
    const p = this.openPreserve();
    return p && !isElixir(p) && !!p.openedAt ? p : null;
  });
  protected readonly openInElixir = computed(() => {
    const p = this.openPreserve();
    return p && isElixir(p) ? p : null;
  });

  protected monthWordFor(preserve: Preserve): string {
    return this.monthWordOf(preserve.madeAt);
  }

  /** What the hero jar actually holds: fresh fruits — not yet jammed, not
   *  stored in a promised jar. The number matches the picture. */
  protected readonly freshCount = computed(() => this.harvests.fresh().length);

  protected toggle(id: string): void {
    this.openId.set(this.openId() === id ? null : id);
  }

  protected onEscape(): void {
    if (this.openInPending()) {
      this.host.nativeElement.querySelector<HTMLElement>('.pending-jar.selected')?.focus();
    }
    if (this.openId()) this.openId.set(null);
  }

  protected openWizard(): void {
    if (this.promise.atLimit()) return;
    this.promising.set(true);
  }

  /** Wizard minted a new promise: open its detail so the user sees the empty
   *  jar waiting for its first fruit. */
  protected onPromiseCreated(preserve: Preserve): void {
    this.promising.set(false);
    this.openId.set(preserve.id);
    afterNextRender(() => {
      if (this.openId() === preserve.id) this.pendingDetail()?.focusPanel();
    }, { injector: this.injector });
  }

  /** jar-detail asked to release a pending jar → confirm + toast (page owns). */
  protected askRelease(preserve: Preserve): void {
    this.releasing.set(preserve);
  }

  protected async doRelease(): Promise<void> {
    const jar = this.releasing();
    if (!jar) return;
    this.releasing.set(null);
    if (!(await this.promise.release(jar))) return;
    if (this.openId() === jar.id) this.openId.set(null);
    this.toast.show({ message: this.i18n.t().cosecha.promise.released }, UNDO_MS);
  }

  /** «Hacer mermelada» (0.0.96): the user cooked a full goal jar → seal it (the
   *  premio carries over) + one undo window (unmake → full pending again). */
  protected async onMade(preserve: Preserve): Promise<void> {
    const jar = await this.promise.makeJam(preserve.id);
    this.making.set(null);
    if (!jar) return;
    this.toast.show(
      {
        message: this.i18n.t().cosecha.jamMadeToast,
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.promise.unmakeJam(jar.id),
      },
      UNDO_MS,
    );
  }

  /** Seal landed: close the ritual, offer the one undo window. */
  protected onSealed(preserve: Preserve): void {
    this.makingJam.set(false);
    this.toast.show(
      {
        message: this.i18n.t().cosecha.jamMadeToast,
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.conserveria.unseal(preserve),
      },
      UNDO_MS,
    );
  }

  /** Claim landed: the jar stands «disfrutada»; one undo window. */
  protected onOpened(preserve: Preserve): void {
    this.claiming.set(null);
    this.toast.show(
      {
        // A farewell toast is a BRINDIS, not an opened jam — same undo window.
        message: isElixir(preserve) ? this.i18n.t().cosecha.brindadoToast : this.i18n.t().cosecha.openedToast,
        actionLabel: this.i18n.t().common.undo,
        action: () => void this.conserveria.reclose(preserve),
      },
      UNDO_MS,
    );
  }

  /** Accent-washed tree chip — the almanaque's categorical recipe (register). */
  protected chipWash(row: HarvestRow): string {
    return `color-mix(in srgb, var(--accent-${row.harvest.accent}) 14%, var(--surface))`;
  }

  protected chipBorder(row: HarvestRow): string {
    return `color-mix(in srgb, var(--accent-${row.harvest.accent}) 32%, transparent)`;
  }

  /** Reread in place — the Trail's door: the branch on its own tree. */
  protected openBranch(row: HarvestRow): void {
    if (!row.live) return;
    void this.router.navigate(['/tree', row.harvest.treeId], {
      queryParams: { node: row.harvest.nodeId },
    });
  }

  protected goBack(): void {
    if (history.length > 1) {
      this.location.back();
    } else {
      void this.router.navigate(['/forest']);
    }
  }
}
