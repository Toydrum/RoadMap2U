import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Harvest, JarVessel, Preserve } from '../../core/db/schema';
import { ConserveriaService, SealTint } from '../../core/conserveria.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { PreservesRepo } from '../../core/repos/preserves.repo';
import { deriveAccent, jarCapacity } from '../../core/harvest';
import { jamTint } from '../forest/flora';
import { I18nService } from '../../core/i18n/i18n.service';
import { ToastService, UNDO_MS } from '../../shared/ui/toast.service';

/**
 * «La promesa» (0.0.93) — the goal-jar feature service. It owns the palette
 * (flora's jamTint) so core stays feature-free: the caller computes every seal
 * tint and hands it to ConserveriaService. It also enforces the ≤3 pending
 * limit. Filling never seals (0.0.96) — the user MAKES the jam themselves.
 *
 * Two jar families now share the Preserve store: frascos de la olla (size from
 * the fruit, past-facing — the mermelada ritual) vs frascos prometidos (size =
 * the user's OWN valuation of their premio; the app never suggests reward↔size).
 */

/** The upper bound on goal jars filling at once — a small, focused shelf of
 *  promises (same spirit as «ramas de hoy ≤3»). */
export const MAX_PENDING_PROMISES = 3;

/** A pending jar shows its fruits, never a jam liquid, so its stored tint is
 *  only a neutral placeholder until the seal recomputes the real blend. */
const NEUTRAL_TINT = '#d9d2c4';
const NEUTRAL_TINT_EDGE = '#b7ad99';
const EMPTY_MEMBERS: Harvest[] = [];

@Injectable({ providedIn: 'root' })
export class PromiseService {
  private readonly conserveria = inject(ConserveriaService);
  private readonly harvests = inject(HarvestsRepo);
  private readonly preserves = inject(PreservesRepo);
  private readonly i18n = inject(I18nService);
  private readonly toast = inject(ToastService);

  /** Unsealed goal jars, newest promise first. */
  readonly pending = this.preserves.pending;
  readonly atLimit = computed(() => this.pending().length >= MAX_PENDING_PROMISES);
  readonly acceptingFruit = computed(() => this.pending().filter((jar) => !this.isFull(jar)));
  private readonly membersByJar = computed(() => {
    const byJar = new Map<string, Harvest[]>();
    for (const fruit of this.harvests.all()) {
      if (!fruit.preserveId) continue;
      const members = byJar.get(fruit.preserveId);
      if (members) members.push(fruit);
      else byJar.set(fruit.preserveId, [fruit]);
    }
    return byJar;
  });

  /** A fresh fruit awaiting a jar choice — set by the bloom toast when >1 jar
   *  is pending; a cross-page picker host (mounted in App) reads it. */
  readonly placementRequest = signal<Harvest | null>(null);

  constructor() {
    // The picker dissolves when its REASON dissolves (0.0.115 B4): jars all
    // released in another tab, or the fruit placed/tombstoned elsewhere,
    // used to leave a cross-page sheet with nothing true left to offer.
    effect(() => {
      const fruit = this.placementRequest();
      if (!fruit) return;
      const live = this.harvests.byId().get(fruit.id);
      if (!this.acceptingFruit().length || !live || live.deletedAt || live.preserveId) {
        this.placementRequest.set(null);
      }
    });
  }
  requestPlacement(h: Harvest): void {
    const live = this.harvests.byId().get(h.id);
    if (live && !live.deletedAt && !live.preserveId && this.acceptingFruit().length) {
      this.placementRequest.set(live);
    }
  }
  clearPlacement(): void {
    this.placementRequest.set(null);
  }

  /** Live members of a jar (the fruits placed so far). */
  membersOf(preserveId: string): Harvest[] {
    return this.membersByJar().get(preserveId) ?? EMPTY_MEMBERS;
  }

  capacity(size: JarVessel | undefined): number {
    return jarCapacity(size ?? 'frasco');
  }

  /** Create an empty goal jar from the wizard (refused past the limit). */
  create(fields: {
    name: string;
    size: JarVessel;
    premio: string;
  }): Promise<Preserve | null> {
    if (this.atLimit()) return Promise.resolve(null);
    return this.conserveria.promise({
      ...fields,
      tint: NEUTRAL_TINT,
      tintEdge: NEUTRAL_TINT_EDGE,
    });
  }

  /** The seal color a member set WOULD blend to (flora lives here, not core). */
  private sealTintFor(members: Harvest[]): SealTint {
    return { accent: deriveAccent(members), ...jamTint(members.map((m) => m.accent)) };
  }

  /** True when a goal jar has gathered its capacity — ready to be MADE. */
  isFull(preserve: Preserve): boolean {
    return this.membersOf(preserve.id).length >= this.capacity(preserve.size);
  }

  /** Place a fresh fruit into a pending jar (never seals — 0.0.96). */
  place(harvestId: string, preserveId: string) {
    return this.conserveria.place(harvestId, preserveId);
  }

  /** Place a fruit; if that placement FILLS the jar, celebrate the fill and
   *  point to «Hacer mermelada» (the app never self-seals — the user makes it). */
  async placeAndCelebrate(harvestId: string, preserveId: string): Promise<boolean> {
    const res = await this.place(harvestId, preserveId);
    if (!res) return false;
    if (res.filled) {
      this.toast.show(
        { message: this.i18n.fill(this.i18n.t().cosecha.promise.filledToast, { name: res.jar.name }) },
        UNDO_MS,
      );
    }
    return true;
  }

  unplace(harvestId: string) {
    return this.conserveria.unplace(harvestId);
  }

  edit(preserveId: string, fields: { name?: string; premio?: string; savedFor?: string }) {
    return this.conserveria.editPromise(preserveId, fields);
  }

  release(preserve: Preserve) {
    return this.conserveria.release(preserve);
  }

  /** «Hacer mermelada»: seal a full goal jar (the user's act). The caller runs
   *  the cook ceremony; this computes the blended tint + seals. */
  makeJam(preserveId: string) {
    const members = this.membersOf(preserveId);
    return this.conserveria.makeJam(preserveId, this.sealTintFor(members));
  }

  /** Undo of «Hacer mermelada»: back to a full pending jar. */
  unmakeJam(preserveId: string) {
    return this.conserveria.unmakeJam(preserveId);
  }
}
