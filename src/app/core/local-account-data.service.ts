import { Injectable, InjectionToken, inject } from '@angular/core';
import { AccessService } from './access/access.service';
import { broadcastChange, broadcastMutation } from './db/broadcast';
import {
  ACCOUNT_CLOSURE_FENCE_KEY,
  activateAccountClosureFence,
  finalizeAccountClosureFence,
  type StoreName,
  getAll,
  replaceAllForAccountClosure,
} from './db/idb';
import {
  drainAccountClosureWrites,
  quiesceAccountClosureWrites,
  resumeAccountClosureWritesLocally,
} from './db/account-closure-fence';
import { FamilyService } from './family.service';
import { CheckinsRepo } from './repos/checkins.repo';
import { HarvestsRepo } from './repos/harvests.repo';
import { NodesRepo } from './repos/nodes.repo';
import { PreservesRepo } from './repos/preserves.repo';
import { SessionsRepo } from './repos/sessions.repo';
import { SettingsService } from './repos/settings.service';
import { TreesRepo } from './repos/trees.repo';
import { SyncConflictStore } from './sync/sync-conflict.store';
import { SyncService } from './sync/sync.service';
import { BackupService } from './repos/backup.service';
import { DEFAULT_SETTINGS, type Settings } from './db/schema';

const DATA_STORES = Object.freeze([
  'trees',
  'nodes',
  'checkins',
  'sessions',
  'harvests',
  'preserves',
] as const satisfies readonly StoreName[]);

const PRESERVED_META_KEYS: ReadonlySet<string> = new Set([
  // Without this sentinel a pre-rename safety database could be copied back
  // into a deliberately cleared account on next boot.
  'legacy.migratedAt',
  // The live database remains structurally and data-shape current.
  'schema.version',
  // Preserved only until provider sign-out succeeds. If the tab crashes
  // between replace and sign-out, the owner-scoped receipt remains findable.
  'auth.identity',
  ACCOUNT_CLOSURE_FENCE_KEY,
]);

interface MetaRow {
  readonly key: string;
  readonly [field: string]: unknown;
}

export function metaRowsPreservedAfterAccountClosure(
  rows: readonly unknown[],
  receiptKey: string,
): MetaRow[] {
  return rows.filter(
    (row): row is MetaRow =>
      Boolean(row) &&
      typeof row === 'object' &&
      typeof (row as Record<string, unknown>)['key'] === 'string' &&
      (PRESERVED_META_KEYS.has((row as Record<string, unknown>)['key'] as string) ||
        (row as Record<string, unknown>)['key'] === receiptKey),
  );
}

function settingsSnapshotForFinalBackup(rows: readonly unknown[]): Settings {
  const settingsRow = rows.find(
    (row) =>
      Boolean(row) &&
      typeof row === 'object' &&
      (row as Record<string, unknown>)['key'] === 'settings',
  ) as Record<string, unknown> | undefined;
  const value = settingsRow?.['value'];
  return value && typeof value === 'object'
    ? { ...DEFAULT_SETTINGS, ...(value as Partial<Settings>) }
    : { ...DEFAULT_SETTINGS };
}

export interface LocalAccountStorage {
  readMeta(): Promise<unknown[]>;
  replace(entries: { store: StoreName; rows: unknown[] }[]): Promise<void>;
}

export const LOCAL_ACCOUNT_STORAGE = new InjectionToken<LocalAccountStorage>(
  'LOCAL_ACCOUNT_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      readMeta: () => getAll<unknown>('meta'),
      replace: (entries) => replaceAllForAccountClosure(entries),
    }),
  },
);

export interface LocalAccountBroadcast {
  quiesce(): Promise<void> | void;
  reset(): void;
}

export const LOCAL_ACCOUNT_BROADCAST = new InjectionToken<LocalAccountBroadcast>(
  'LOCAL_ACCOUNT_BROADCAST',
  {
    providedIn: 'root',
    factory: () => ({
      quiesce: () => {
        quiesceAccountClosureWrites();
        return drainAccountClosureWrites();
      },
      reset: () => {
        broadcastMutation(DATA_STORES.map((store) => ({ store, ids: [], reset: true })));
        broadcastChange({ store: 'meta', ids: ['settings'] });
      },
    }),
  },
);

export interface LocalAccountFence {
  activate(receiptKey: string): Promise<void>;
  finalize(receiptKey: string): Promise<void>;
}

export interface LocalAccountBackup {
  downloadFinalCopy(settingsSnapshot: Settings): Promise<void>;
}

export const LOCAL_ACCOUNT_BACKUP = new InjectionToken<LocalAccountBackup>(
  'LOCAL_ACCOUNT_BACKUP',
  {
    providedIn: 'root',
    factory: () => {
      const backup = inject(BackupService);
      return {
        downloadFinalCopy: (settingsSnapshot) =>
          backup.download('roadmap2u-final-account-closure', {
            recordCopy: false,
            settingsSnapshot,
          }),
      };
    },
  },
);

export const LOCAL_ACCOUNT_FENCE = new InjectionToken<LocalAccountFence>('LOCAL_ACCOUNT_FENCE', {
  providedIn: 'root',
  factory: () => ({
    activate: (receiptKey) => activateAccountClosureFence(receiptKey),
    finalize: async (receiptKey) => {
      await finalizeAccountClosureFence(receiptKey);
      resumeAccountClosureWritesLocally();
    },
  }),
});

/** Terminal-only local cleanup. AccountClosureService is the only caller. */
@Injectable({ providedIn: 'root' })
export class LocalAccountDataService {
  private readonly storage = inject(LOCAL_ACCOUNT_STORAGE);
  private readonly broadcast = inject(LOCAL_ACCOUNT_BROADCAST);
  private readonly fence = inject(LOCAL_ACCOUNT_FENCE);
  private readonly backup = inject(LOCAL_ACCOUNT_BACKUP);
  private readonly trees = inject(TreesRepo);
  private readonly nodes = inject(NodesRepo);
  private readonly checkins = inject(CheckinsRepo);
  private readonly sessions = inject(SessionsRepo);
  private readonly harvests = inject(HarvestsRepo);
  private readonly preserves = inject(PreservesRepo);
  private readonly settings = inject(SettingsService);
  private readonly sync = inject(SyncService);
  private readonly access = inject(AccessService);
  private readonly family = inject(FamilyService);
  private readonly conflicts = inject(SyncConflictStore);

  async clear(receiptKey: string): Promise<void> {
    if (!/^account\.closure:[a-z0-9-]{1,160}$/.test(receiptKey)) {
      throw new Error('invalid account closure receipt key');
    }
    // The process signal stops producers immediately for UX; the durable IDB
    // generation fence is authority across tabs and serializes with writes
    // which already started before this call.
    const localWriteDrain = Promise.resolve(this.broadcast.quiesce());
    await this.fence.activate(receiptKey);
    await Promise.all([
      localWriteDrain,
      this.sync.resetAfterAccountClosure(),
      this.access.resetAfterAccountClosure(),
      this.family.resetAfterAccountClosure(),
      this.conflicts.resetAfterAccountClosure(),
      this.settings.resetAfterAccountClosure(),
    ]);

    // A write may have crossed the first export before the user confirmed,
    // then committed before the durable fence. Capture that final stable
    // disk image after every producer drained and before replacement.
    const metaRows = await this.storage.readMeta();
    await this.backup.downloadFinalCopy(settingsSnapshotForFinalBackup(metaRows));

    const preservedMeta = metaRowsPreservedAfterAccountClosure(metaRows, receiptKey);
    await this.storage.replace([
      ...DATA_STORES.map((store) => ({ store, rows: [] })),
      { store: 'meta', rows: preservedMeta },
    ]);

    this.trees.resetTo([]);
    this.nodes.resetTo([]);
    this.checkins.resetTo([]);
    this.sessions.resetTo([]);
    this.harvests.resetTo([]);
    this.preserves.resetTo([]);
    this.broadcast.reset();
  }

  /** Final meta transaction after provider/local identity sign-out. */
  async finalize(receiptKey: string): Promise<void> {
    await this.fence.finalize(receiptKey);
  }
}
