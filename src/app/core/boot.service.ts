import { Injectable, inject } from '@angular/core';
import { TreesRepo } from './repos/trees.repo';
import { NodesRepo } from './repos/nodes.repo';
import { CheckinsRepo } from './repos/checkins.repo';
import { SessionsRepo } from './repos/sessions.repo';
import { HarvestsRepo } from './repos/harvests.repo';
import { PreservesRepo } from './repos/preserves.repo';
import { SettingsService } from './repos/settings.service';
import { onDbChange } from './db/broadcast';
import { storageAvailable } from './db/idb';
import { ToastService } from '../shared/ui/toast.service';
import { I18nService } from './i18n/i18n.service';
import { APP_CONFIG, DEPLOY_STAGE } from './config';
import {
  FOREST_REPLACEMENT_STORAGE,
  ForestMutationsService,
} from './repos/forest-mutations.service';

/** Loads every store into memory before first render and wires cross-tab refresh. */
@Injectable({ providedIn: 'root' })
export class BootService {
  private readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly checkins = inject(CheckinsRepo);
  private readonly sessions = inject(SessionsRepo);
  private readonly harvests = inject(HarvestsRepo);
  private readonly preserves = inject(PreservesRepo);
  private readonly settings = inject(SettingsService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(I18nService);
  private readonly mutations = inject(ForestMutationsService);
  private readonly replacement = inject(FOREST_REPLACEMENT_STORAGE);

  async init(): Promise<void> {
    // Loads catch their own storage failures; allSettled is belt-and-braces —
    // a broken IndexedDB must never leave the user staring at a blank screen.
    await Promise.allSettled([
      this.trees.load(),
      this.nodes.load(),
      this.checkins.load(),
      this.sessions.load(),
      this.harvests.load(),
      this.preserves.load(),
      this.settings.load(),
    ]);

    onDbChange(({ store, ids, reset }) => {
      // Settings travel too — lastCheckInAt/todayIntentions/lastWhisperAt
      // are behavioral, and a tab that can't see them re-routes to a
      // check-in already done and whispers on its own clock.
      if (store === 'meta') {
        if (ids.includes('settings')) void this.settings.load();
        return;
      }
      const repo =
        store === 'trees' ? this.trees
        : store === 'nodes' ? this.nodes
        : store === 'checkins' ? this.checkins
        : store === 'sessions' ? this.sessions
        : store === 'harvests' ? this.harvests
        : store === 'preserves' ? this.preserves
        : null;
      // reset = an import-replace put OLDER revs on disk: reload wholesale
      // (load() replaces memory), never through the LWW guard (0.0.115 A1).
      if (reset) void repo?.load();
      else void repo?.refreshFromDisk(ids);
    });

    await this.maybeSeedDemo();

    // «La cosecha» v5 wake-up: AFTER the demo seed so a seeded showcase
    // forest gets its pantry too. One-time, sentinel-sealed.
    await this.harvests.backfillIfNeeded(this.nodes.byId(), this.trees.byId());

    // Memory-only degrade must never be SILENT: an empty forest over an
    // intact disk store reads as data loss, and work done in this session
    // evaporates on reload. One honest sticky notice.
    if (!(await storageAvailable())) {
      this.toast.show({ message: this.i18n.t().app.memoryOnly, sticky: true });
    }
  }

  /** `?seed=demo` on an EMPTY store loads a small showcase forest. */
  private async maybeSeedDemo(): Promise<void> {
    if (new URLSearchParams(location.search).get('seed') !== 'demo') return;
    if (APP_CONFIG.backend !== 'mock' || String(DEPLOY_STAGE) !== 'local') return;
    const demo = await import('./demo-seed');
    await demo.maybeSeedDemoForest({
      search: location.search,
      environment: { backend: APP_CONFIG.backend, stage: DEPLOY_STAGE },
      ports: {
        // Any tombstone/history row means the device is lived-in. The demo
        // replacement must never clear real local data just because all
        // visible trees happen to be archived or deleted.
        hasLocalData: () =>
          [
            this.trees,
            this.nodes,
            this.checkins,
            this.sessions,
            this.harvests,
            this.preserves,
          ].some((repo) => repo.byId().size > 0),
        assertSeed: (trees, nodes, context) =>
          this.mutations.assertSeed(trees, nodes, context),
        replaceIfEmpty: (entries) => this.replacement.replaceIfEmpty(entries),
        resetTrees: (rows) => this.trees.resetTo(rows),
        resetNodes: (rows) => this.nodes.resetTo(rows),
        resetCheckins: (rows) => this.checkins.resetTo(rows),
        resetSessions: (rows) => this.sessions.resetTo(rows),
        resetHarvests: (rows) => this.harvests.resetTo(rows),
        resetPreserves: (rows) => this.preserves.resetTo(rows),
        patchSettings: (patch) => this.settings.patch(patch),
      },
    });
  }
}
