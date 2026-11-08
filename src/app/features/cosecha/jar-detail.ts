import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { Harvest, Preserve } from '../../core/db/schema';
import { isElixir, isPending, membersOf } from '../../core/harvest';
import { FruitSpec, fruitFor } from '../forest/flora';
import { FruitGlyph } from '../forest/fruit';
import { PromiseJar } from '../forest/promise-jar';
import { ElixirVial } from '../forest/elixir-vial';
import { PromiseService } from './promise.service';

interface MemberRow {
  harvest: Harvest;
  spec: FruitSpec;
  when: string;
  live: boolean;
}

/**
 * «El detalle del frasco» (0.0.94) — ONE inline panel for every jar, whatever
 * its family. It replaced the two near-identical panels (sealed pot jam vs
 * pending goal jar) that used to live inline in cosecha.html and could both be
 * open at once. It renders the right mode from the record itself:
 *   · PENDING goal jar (isPending): PromiseJar hero + the one «lleva n · le
 *     caben cap» line + editable name/premio + members with «Sacar» + an add
 *     tray + «Soltar».
 *   · SEALED jam, un-opened WITH a premio: «Abrir» (memory jars — no premio —
 *     keep no open door, 0.0.90 law) + members (deep-link to live branches).
 *   · DISFRUTADA (openedAt): the enjoyed line + members.
 * Pending mutations run through PromiseService directly (placeAndCelebrate owns
 * the auto-seal toast); page-level moments (the claiming ceremony, the release
 * confirm + toast) are emitted so cosecha keeps owning them. Class names are
 * preserved from the old panels so the verify battery stays intact.
 */
@Component({
  selector: 'app-jar-detail',
  imports: [FruitGlyph, PromiseJar, ElixirVial],
  templateUrl: './jar-detail.html',
  styleUrl: './cosecha.scss',
})
export class JarDetail {
  protected readonly i18n = inject(I18nService);
  protected readonly promise = inject(PromiseService);
  protected readonly harvests = inject(HarvestsRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly router = inject(Router);

  readonly preserve = input.required<Preserve>();
  /** Making-month word for the sealed header (blank for pending). */
  readonly monthWord = input<string>('');
  readonly claim = output<Preserve>();
  readonly release = output<Preserve>();
  /** «Hacer mermelada» — the user seals a full goal jar (0.0.96). */
  readonly make = output<Preserve>();

  /** A pending goal jar that has gathered its capacity — ready to be made. */
  protected readonly full = computed(() => this.pending() && this.promise.isFull(this.preserve()));

  protected readonly inputValue = (e: Event) => (e.target as HTMLInputElement).value;

  protected readonly pending = computed(() => isPending(this.preserve()));
  protected readonly elixir = computed(() => isElixir(this.preserve()));
  protected readonly panelId = computed(() =>
    this.elixir() ? 'elixir-panel' : this.pending() ? 'pending-panel' : 'jar-panel',
  );

  /** Add-tray + edit-form local state (was on the page). */
  protected readonly addOpen = signal(false);
  protected readonly editOpen = signal(false);
  protected readonly editName = signal('');
  protected readonly editPremio = signal('');

  private rowOf(harvest: Harvest): MemberRow {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const node = this.nodes.byId().get(harvest.nodeId);
    return {
      harvest,
      spec: fruitFor(harvest.accent, harvest.treeId),
      when: new Date(harvest.harvestedAt).toLocaleDateString(locale, { day: 'numeric', month: 'long' }),
      live: !!node && !node.deletedAt && !node.archivedAt,
    };
  }

  /** An elixir reads the tree's fruits by treeId. A jam reads its sealed members by preserveId. */
  protected readonly members = computed(() => {
    const p = this.preserve();
    const source = this.elixir()
      ? this.harvests
          .all()
          .filter((h) => h.treeId === p.treeId)
          .sort((a, b) => b.harvestedAt - a.harvestedAt || (a.id < b.id ? -1 : 1))
      : membersOf(p.id, this.harvests.all());
    return source.map((h) => this.rowOf(h));
  });
  protected readonly freshRows = computed(() => this.harvests.fresh().map((h) => this.rowOf(h)));

  protected carryLine(): string {
    return this.i18n.fill(this.i18n.t().cosecha.carryLine, { carry: this.preserve().carry ?? '' });
  }
  protected brindadoLine(): string {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const date = new Date(this.preserve().openedAt ?? 0).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'long',
    });
    return this.i18n.fill(this.i18n.t().cosecha.brindado, { date });
  }

  /** The ONE forward count line — lives only here (owner carve-out). */
  protected readonly fillLine = computed(() => {
    const p = this.preserve();
    const have = this.promise.membersOf(p.id).length;
    const cap = this.promise.capacity(p.size);
    const dict = this.i18n.t().cosecha.promise.fillLine;
    return this.i18n.fill(have === 1 ? dict.one : dict.many, { count: have, cap });
  });

  protected premioReward(): string {
    return this.i18n.fill(this.i18n.t().cosecha.premioReward, { premio: this.preserve().premio ?? '' });
  }

  protected savedForLine(): string {
    return this.i18n.fill(this.i18n.t().cosecha.savedForLine, { savedFor: this.preserve().savedFor ?? '' });
  }

  protected enjoyedLine(): string {
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const date = new Date(this.preserve().openedAt ?? 0).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'long',
    });
    return this.i18n.fill(this.i18n.t().cosecha.enjoyedOn, { date });
  }

  protected chipWash(row: MemberRow): string {
    return `color-mix(in srgb, var(--accent-${row.harvest.accent}) 14%, var(--surface))`;
  }
  protected chipBorder(row: MemberRow): string {
    return `color-mix(in srgb, var(--accent-${row.harvest.accent}) 32%, transparent)`;
  }

  protected openBranch(row: MemberRow): void {
    if (!row.live) return;
    void this.router.navigate(['/tree', row.harvest.treeId], {
      queryParams: { node: row.harvest.nodeId },
    });
  }

  // ── pending mutations ────────────────────────────────────────────────────
  protected addFruit(harvestId: string): void {
    void this.promise.placeAndCelebrate(harvestId, this.preserve().id);
    if (!this.harvests.fresh().length) this.addOpen.set(false);
  }

  protected removeFruit(harvestId: string): void {
    void this.promise.unplace(harvestId);
  }

  protected startEdit(): void {
    const p = this.preserve();
    this.editName.set(p.name);
    this.editPremio.set(p.premio ?? '');
    this.editOpen.set(true);
  }

  protected saveEdit(): void {
    // savedFor deliberately unpassed (0.0.108) — editPromise preserves a
    // legacy value when the field doesn't travel.
    void this.promise.edit(this.preserve().id, {
      name: this.editName(),
      premio: this.editPremio(),
    });
    this.editOpen.set(false);
  }
}
