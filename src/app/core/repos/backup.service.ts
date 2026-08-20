import { Injectable, inject } from '@angular/core';
import {
  CheckIn,
  ExportEnvelope,
  Harvest,
  Preserve,
  SCHEMA_VERSION,
  Settings,
  TimerSession,
  Tree,
  TreeNode,
} from '../db/schema';
import { migrateBackupEnvelope } from '../db/migrations';
import { getAll } from '../db/idb';
import { broadcastChange } from '../db/broadcast';
import { SyncService } from '../sync/sync.service';
import { TreesRepo } from './trees.repo';
import { NodesRepo } from './nodes.repo';
import { CheckinsRepo } from './checkins.repo';
import { SessionsRepo } from './sessions.repo';
import { HarvestsRepo } from './harvests.repo';
import { PreservesRepo } from './preserves.repo';
import { SettingsService } from './settings.service';
import {
  FOREST_REPLACEMENT_STORAGE,
  ForestMutationsService,
} from './forest-mutations.service';

@Injectable({ providedIn: 'root' })
export class BackupService {
  private readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly checkins = inject(CheckinsRepo);
  private readonly sessions = inject(SessionsRepo);
  private readonly harvests = inject(HarvestsRepo);
  private readonly preserves = inject(PreservesRepo);
  private readonly settings = inject(SettingsService);
  private readonly sync = inject(SyncService);
  private readonly mutations = inject(ForestMutationsService);
  private readonly replacement = inject(FOREST_REPLACEMENT_STORAGE);

  async buildEnvelope(): Promise<ExportEnvelope> {
    // Read from disk (includes tombstones — a backup is a full copy).
    const [trees, nodes, checkins, sessions, harvests, preserves] = await Promise.all([
      getAll<Tree>('trees'),
      getAll<TreeNode>('nodes'),
      getAll<CheckIn>('checkins'),
      getAll<TimerSession>('sessions'),
      getAll<Harvest>('harvests'),
      getAll<Preserve>('preserves'),
    ]);
    return {
      app: 'roadmap2u',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      data: {
        trees,
        nodes,
        checkins,
        sessions,
        harvests,
        preserves,
        settings: this.settings.settings(),
      },
    };
  }

  async download(
    filenamePrefix = 'roadmap2u-backup',
    options: { recordCopy?: boolean } = {},
  ): Promise<void> {
    const envelope = await this.buildEnvelope();
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-${envelope.exportedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    // User-triggered and pre-delete downloads stamp immediately. A
    // pre-import safety copy defers its stamp until the replacement commits,
    // so an aborted import changes no application state.
    if (options.recordCopy !== false) {
      await this.settings.patch({ lastBackupAt: Date.now() });
    }
  }

  /**
   * Validate + replace-all. A backup of the CURRENT data is auto-downloaded
   * first, so a bad import is always recoverable. Merge-import is a v2 sync
   * problem — not half-built here.
   */
  async importReplace(json: string): Promise<void> {
    // Validation + the same pure data-shape pipeline used by live IndexedDB
    // happen BEFORE the safety download or any replace transaction. The
    // import-only 'rodemap2u' app id remains accepted inside the migrator.
    const envelope = migrateBackupEnvelope(JSON.parse(json));
    // Validate the WHOLE shape before touching disk: a malformed file that
    // passed the header checks used to wipe the stores and THEN throw —
    // empty forest on next reload.
    const data = envelope.data;
    if (!data || typeof data !== 'object') throw new Error('backup has no data');
    const trees = data.trees ?? [];
    const nodes = data.nodes ?? [];
    const checkins = data.checkins ?? [];
    const sessions = data.sessions ?? [];
    // Pre-v5 backups simply lack harvests — imported as an empty pantry
    // (the backfill sentinel is device state and does NOT re-run; restored
    // achieved branches without their harvests stay fruitless until they
    // re-achieve, which is honest: the backup predates the jar).
    const harvests = data.harvests ?? [];
    // Pre-v6 backups lack preserves — imported as no jars (member fruits
    // also lack preserveId in those backups, so the homes stay consistent).
    const preserves = data.preserves ?? [];
    for (const list of [trees, nodes, checkins, sessions, harvests, preserves]) {
      if (!Array.isArray(list) || list.some((r) => typeof r?.id !== 'string')) {
        throw new Error('backup data is malformed');
      }
    }
    // One decision over the complete replacement candidate. It happens
    // after schema migration and before any download, disk write or signal.
    this.mutations.assertImport(trees, nodes);
    // Records the import REMOVES must also be announced, or a second tab's
    // in-memory copy resurrects them on its next save. From byId() — not
    // all() — so TOMBSTONES count too (0.0.115 B7: a tombstone absent from
    // the backup used to linger in the sibling's memory and re-sync).
    const removedIds = {
      trees: [...this.trees.byId().keys()],
      nodes: [...this.nodes.byId().keys()],
      checkins: [...this.checkins.byId().keys()],
      sessions: [...this.sessions.byId().keys()],
      harvests: [...this.harvests.byId().keys()],
      preserves: [...this.preserves.byId().keys()],
    };

    // The safety file must exist before the destructive transaction, but its
    // device timestamp lands only after that transaction succeeds. Thus an
    // abort leaves both persisted and in-memory application state untouched.
    await this.download('roadmap2u-pre-import', { recordCopy: false });

    // ONE transaction for the whole wipe+rewrite — a failure anywhere rolls
    // the entire import back instead of leaving an empty disk (0.0.115 M1).
    await this.replacement.replace([
      { store: 'trees', rows: trees },
      { store: 'nodes', rows: nodes },
      { store: 'checkins', rows: checkins },
      { store: 'sessions', rows: sessions },
      { store: 'harvests', rows: harvests },
      { store: 'preserves', rows: preserves },
    ]);

    this.trees.resetTo(trees);
    this.nodes.resetTo(nodes);
    this.checkins.resetTo(checkins);
    this.sessions.resetTo(sessions);
    this.harvests.resetTo(harvests);
    this.preserves.resetTo(preserves);
    let preferences: Partial<Settings> = {};
    if (data.settings) {
      // Preferences travel; DEVICE STATE does not (same law that keeps
      // auth/sync out of the envelope): the whispers toggle is THIS
      // device's permission gesture, and the backup/check-in/whisper
      // timestamps belong to this device's clock — restoring a stale
      // lastBackupAt would clobber the pre-import copy we JUST made and
      // re-arm the 30-day nudge right after a restore.
      const {
        lastBackupAt: _a,
        lastBackupNudgeAt: _b,
        lastCheckInAt: _c,
        lastWhisperAt: _d,
        whispersEnabled: _e,
        ...importedPreferences
      } = data.settings;
      preferences = importedPreferences;
    }
    await this.settings.patch({ ...preferences, lastBackupAt: Date.now() });

    // Other tabs re-read what the import replaced (same rail as every write);
    // ids no longer on disk get DROPPED from their memory by refreshFromDisk.
    const union = (kept: { id: string }[], removed: string[]) => [
      ...new Set([...removed, ...kept.map((r) => r.id)]),
    ];
    // reset:true — the restored records carry OLDER revs than the live
    // copies, so sibling tabs must reload wholesale instead of letting the
    // LWW guard in applyExternal reject the restoration (0.0.115 audit A1:
    // the sibling tab used to keep the pre-import forest and could re-push
    // exactly what the user reverted).
    broadcastChange({ store: 'trees', ids: union(trees, removedIds.trees), reset: true });
    broadcastChange({ store: 'nodes', ids: union(nodes, removedIds.nodes), reset: true });
    broadcastChange({ store: 'checkins', ids: union(checkins, removedIds.checkins), reset: true });
    broadcastChange({ store: 'sessions', ids: union(sessions, removedIds.sessions), reset: true });
    broadcastChange({ store: 'harvests', ids: union(harvests, removedIds.harvests), reset: true });
    broadcastChange({ store: 'preserves', ids: union(preserves, removedIds.preserves), reset: true });

    // An explicit restore must WIN over the cloud — without this, the next
    // pull silently resurrects whatever the backup rolled back (cloud revs
    // are higher than the restored ones). Persistent flag: covers offline
    // imports and import-before-connect too.
    await this.sync.noteRestore();
  }
}
