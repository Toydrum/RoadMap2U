import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { NavigationExtras, Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { Feeling, Tree, TreeNode } from '../../core/db/schema';
import { MiniTree } from '../forest/mini-tree';

const FEELINGS: { key: Feeling; emoji: string }[] = [
  { key: 'sunny', emoji: '☀️' },
  { key: 'calm', emoji: '🌤' },
  { key: 'foggy', emoji: '🌫' },
  { key: 'heavy', emoji: '🌧' },
  { key: 'stormy', emoji: '⛈' },
];

type Step = 'welcome' | 'feeling' | 'destination';

/** Past this many trees the circle interleaves two radii and shrinks. */
const RING_COMFORT = 9;

/** Branch shortcuts shown on the destination step — a hand, not a catalog. */
const DESTINATION_BRANCHES = 4;

/**
 * The opening ritual, two screens flat: how are you → where to.
 * (Plus a one-time welcome the very first time the forest greets someone.)
 * The optional notita folds into the first screen; the second merges the old
 * branch picker and the circle of trees. Skippable at every step, no guilt.
 * Passed dates never interrupt here — Ahora's banner is their single home.
 */
@Component({
  selector: 'app-check-in',
  imports: [MiniTree],
  templateUrl: './check-in.html',
  styleUrl: './check-in.scss',
})
export class CheckInPage {
  protected readonly inputValue = inputValue;
  protected readonly i18n = inject(I18nService);
  protected readonly nodes = inject(NodesRepo);
  protected readonly trees = inject(TreesRepo);
  protected readonly checkins = inject(CheckinsRepo);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);

  protected readonly feelings = FEELINGS;
  protected readonly step = signal<Step>('feeling');
  protected readonly feeling = signal<Feeling | null>(null);
  /** Optional energy selection. The feeling tap advances the step. */
  protected readonly energy = signal<'llena' | 'media' | 'bajita' | null>(null);
  protected readonly energyOpen = signal(false);
  protected readonly energyTokens = ['bajita', 'media', 'llena'] as const;

  protected toggleEnergy(token: 'llena' | 'media' | 'bajita'): void {
    this.energy.set(this.energy() === token ? null : token);
  }
  protected readonly note = signal('');
  protected readonly noteOpen = signal(false);

  private readonly noteBox = viewChild<ElementRef<HTMLTextAreaElement>>('noteBox');

  constructor() {
    if (!this.settings.settings().onboarded) this.step.set('welcome');
  }

  /** Freshest live branches across the forest — shortcuts on the destination
   *  step. A container heart (0.0.112) is not a destination-task — its tree
   *  ring entry already is the whole tree's door. */
  protected readonly candidates = computed(() => {
    const result: { treeName: string; accent: string; node: TreeNode }[] = [];
    for (const tree of this.trees.active()) {
      const heart = this.nodes.heartOf(tree.id);
      for (const node of this.nodes.byTree().get(tree.id) ?? []) {
        if (node.status !== 'growing' && node.status !== 'seed') continue;
        if (heart && node.id === heart.id && this.nodes.childrenOf(node).length > 0) continue;
        result.push({ treeName: tree.name, accent: tree.accent, node });
      }
    }
    return result.sort((a, b) => b.node.updatedAt - a.node.updatedAt).slice(0, DESTINATION_BRANCHES);
  });

  /** The freshest little note — a letter your past self left for today. */
  protected readonly lastNote = computed(
    () =>
      [...this.checkins.all()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .find((c) => c.note.trim().length > 0) ?? null,
  );

  protected lastNoteDate(): string {
    const letter = this.lastNote();
    if (!letter) return '';
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    return new Date(letter.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
  }

  protected begin(): void {
    this.step.set('feeling');
  }

  protected pickFeeling(feeling: Feeling): void {
    this.feeling.set(feeling);
    if (this.trees.active().length) {
      this.step.set('destination');
    } else {
      // Empty forest: nothing to choose from — land planting, sheet already open.
      void this.depart(['/forest'], { queryParams: { plant: 1 } });
    }
  }

  protected openNote(): void {
    this.noteOpen.set(true);
    setTimeout(() => this.noteBox()?.nativeElement.focus(), 30);
  }

  /** A mis-tap is not a commitment — steps walk back, choices stay. */
  protected stepBack(): void {
    if (this.step() === 'destination') this.step.set('feeling');
  }

  protected feelingEmoji(feeling: Feeling): string {
    return FEELINGS.find((f) => f.key === feeling)?.emoji ?? '';
  }

  /** One tap: same weather as last time, no note, no place — back to Ahora. */
  protected async expressCheckIn(): Promise<void> {
    const last = this.checkins.latest();
    if (!last) return;
    await this.checkins.record(last.feeling, { note: '' });
    await this.settings.patch({ lastCheckInAt: Date.now(), onboarded: true });
    void this.router.navigate(['/ahora']);
  }

  /** "Hoy no quiero responder" — always available, never penalized.
   *  Lands on Ahora: orientation without interrogation. */
  protected async skip(): Promise<void> {
    await this.settings.patch({ lastCheckInAt: Date.now(), onboarded: true });
    void this.router.navigate(['/ahora']);
  }

  /** Every real departure records the check-in once, then travels. */
  private async depart(commands: unknown[], extras?: NavigationExtras, where?: TreeNode | null): Promise<void> {
    const feeling = this.feeling();
    if (feeling) {
      await this.checkins.record(feeling, {
        note: this.note().trim(),
        treeId: where?.treeId ?? null,
        nodeId: where?.id ?? null,
        energy: this.energy(),
      });
    }
    await this.settings.patch({ lastCheckInAt: Date.now(), onboarded: true });
    void this.router.navigate(commands, extras);
  }

  /** Destination: a branch shortcut — the 📍 moves with you (record handles it). */
  protected pickBranch(node: TreeNode): void {
    void this.depart(['/tree', node.treeId], undefined, node);
  }

  /** Destination: a whole tree from the circle. */
  protected enterTree(tree: Tree): void {
    void this.depart(['/tree', tree.id]);
  }

  /** Destination: just wander the meadow. */
  protected goForest(): void {
    void this.depart(['/forest']);
  }

  protected readonly ringCrowded = computed(() => this.trees.active().length > RING_COMFORT);

  /** Circular placement for the tree circle. Past RING_COMFORT trees the
   *  circle becomes two interleaved petal rings (outer/inner) and the
   *  miniatures shrink — deterministic, viewport-safe up to ~20 trees. */
  protected ringTransform(index: number): string {
    const count = this.trees.active().length;
    const angle = (360 / Math.max(count, 1)) * index - 90;
    if (count <= RING_COMFORT) {
      return `rotate(${angle}deg) translateX(var(--ring-r)) rotate(${-angle}deg)`;
    }
    const radius = index % 2 === 0 ? 1.14 : 0.78;
    const scale = Math.max(0.6, Math.round((RING_COMFORT / count) * 100) / 100);
    return `rotate(${angle}deg) translateX(calc(var(--ring-r) * ${radius})) rotate(${-angle}deg) scale(${scale})`;
  }

  /** Entrance cascade, capped so a big forest doesn't feel like waiting. */
  protected enterDelay(index: number): string {
    return Math.min(index, 12) * 70 + 'ms';
  }
}
