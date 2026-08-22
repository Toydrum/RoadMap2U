import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from './access/access.service';
import { accountClosureStorageKeyForOwner } from './account-closure.service';
import { FamilyService } from './family.service';
import {
  LOCAL_ACCOUNT_BROADCAST,
  LOCAL_ACCOUNT_BACKUP,
  LOCAL_ACCOUNT_FENCE,
  LOCAL_ACCOUNT_STORAGE,
  LocalAccountDataService,
  metaRowsPreservedAfterAccountClosure,
  type LocalAccountBroadcast,
  type LocalAccountBackup,
  type LocalAccountFence,
  type LocalAccountStorage,
} from './local-account-data.service';
import { CheckinsRepo } from './repos/checkins.repo';
import { HarvestsRepo } from './repos/harvests.repo';
import { NodesRepo } from './repos/nodes.repo';
import { PreservesRepo } from './repos/preserves.repo';
import { SessionsRepo } from './repos/sessions.repo';
import { SettingsService } from './repos/settings.service';
import { TreesRepo } from './repos/trees.repo';
import { SyncConflictStore } from './sync/sync-conflict.store';
import { SyncService } from './sync/sync.service';

describe('local account copy cleanup', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('preserves only schema, legacy-migration and the retry receipt from meta', () => {
    const receiptKey = accountClosureStorageKeyForOwner('owner-a');
    const otherReceiptKey = accountClosureStorageKeyForOwner('owner-b');
    const rows = [
      { key: 'legacy.migratedAt', how: 'copied' },
      { key: 'schema.version', version: 13 },
      { key: receiptKey, receipt: { closureId: 'closure-1', state: 'completed' } },
      { key: otherReceiptKey, receipt: { closureId: 'closure-other', state: 'purging' } },
      { key: 'auth.identity', user: { username: 'private' } },
      {
        key: 'account.closure.fence',
        generation: 1,
        active: true,
        receiptKey,
      },
      { key: 'settings', value: { lang: 'es' } },
      { key: 'account.link', accountId: 'private' },
      { key: 'sync.state', dirty: { nodes: ['private'] } },
      { key: 'sync.conflicts:opaque', conflicts: [{ id: 'private' }] },
      { key: 'family.me', me: { profile: { username: 'private' } } },
      { key: 'commercial.access:private', userId: 'private' },
      { key: 'reminders.fired', days: { private: 'private' } },
    ];

    expect(metaRowsPreservedAfterAccountClosure(rows, receiptKey)).toEqual([
      rows[0],
      rows[1],
      rows[2],
      rows[4],
      rows[5],
    ]);
  });

  it('quiesces account-scoped writers, atomically clears six data stores and user meta, then resets memory', async () => {
    const events: string[] = [];
    const receiptKey = accountClosureStorageKeyForOwner('owner-a');
    const meta = [
      { key: 'legacy.migratedAt', how: 'copied' },
      { key: 'schema.version', version: 13 },
      { key: receiptKey, formatVersion: 1 },
      { key: accountClosureStorageKeyForOwner('owner-b'), formatVersion: 1 },
      { key: 'auth.identity', user: { userId: 'private' } },
      { key: 'account.closure.fence', generation: 1, active: true, receiptKey },
      { key: 'sync.state', dirty: { nodes: ['n-private'] } },
      { key: 'sync.conflicts:opaque', conflicts: [] },
      { key: 'family.me', userId: 'private' },
      { key: 'commercial.access:private', userId: 'private' },
      { key: 'settings', value: { lang: 'en', theme: 'terminal' } },
    ];
    let writesAllowed = true;
    const storage: LocalAccountStorage = {
      readMeta: vi.fn(async () => meta),
      replace: vi.fn(async (entries: Parameters<LocalAccountStorage['replace']>[0]) => {
        events.push('replace');
        events.push(writesAllowed ? 'concurrent-write-resurrected' : 'concurrent-write-blocked');
        expect(entries.map((entry) => entry.store)).toEqual([
          'trees',
          'nodes',
          'checkins',
          'sessions',
          'harvests',
          'preserves',
          'meta',
        ]);
        expect(entries.slice(0, 6).every((entry) => entry.rows.length === 0)).toBe(true);
        expect(entries[6]?.rows).toEqual([meta[0], meta[1], meta[2], meta[4], meta[5]]);
      }),
    };
    const broadcast: LocalAccountBroadcast = {
      quiesce: vi.fn(() => {
        events.push('broadcast-quiesce');
        writesAllowed = false;
      }),
      reset: vi.fn(() => events.push('broadcast')),
    };
    const backup: LocalAccountBackup = {
      downloadFinalCopy: vi.fn(async () => {
        events.push('backup');
      }),
    };
    const fence: LocalAccountFence = {
      activate: vi.fn(async () => {
        events.push('fence-activate');
      }),
      finalize: vi.fn(async () => {
        events.push('fence-finalize');
      }),
    };
    const repo = () => ({ resetTo: vi.fn(() => events.push('repo-reset')) });
    const gates = new Map<string, () => void>();
    const draining = (name: string) =>
      vi.fn(
        () =>
          new Promise<void>((resolve) => {
            events.push(name);
            gates.set(name, resolve);
          }),
      );
    const settings = { resetAfterAccountClosure: draining('settings-quiesce') };
    const sync = { resetAfterAccountClosure: draining('sync-quiesce') };
    const access = { resetAfterAccountClosure: draining('access-quiesce') };
    const family = { resetAfterAccountClosure: draining('family-quiesce') };
    const conflicts = {
      resetAfterAccountClosure: draining('conflicts-quiesce'),
    };

    TestBed.configureTestingModule({
      providers: [
        LocalAccountDataService,
        { provide: LOCAL_ACCOUNT_STORAGE, useValue: storage },
        { provide: LOCAL_ACCOUNT_BROADCAST, useValue: broadcast },
        { provide: LOCAL_ACCOUNT_BACKUP, useValue: backup },
        { provide: LOCAL_ACCOUNT_FENCE, useValue: fence },
        { provide: TreesRepo, useFactory: repo },
        { provide: NodesRepo, useFactory: repo },
        { provide: CheckinsRepo, useFactory: repo },
        { provide: SessionsRepo, useFactory: repo },
        { provide: HarvestsRepo, useFactory: repo },
        { provide: PreservesRepo, useFactory: repo },
        { provide: SettingsService, useValue: settings },
        { provide: SyncService, useValue: sync },
        { provide: AccessService, useValue: access },
        { provide: FamilyService, useValue: family },
        { provide: SyncConflictStore, useValue: conflicts },
      ],
    });

    const clearing = TestBed.inject(LocalAccountDataService).clear(receiptKey);
    await vi.waitFor(() => expect(gates.size).toBe(5));
    expect(storage.replace).not.toHaveBeenCalled();
    for (const release of gates.values()) release();
    await clearing;

    expect(events.slice(0, 7)).toEqual([
      'broadcast-quiesce',
      'fence-activate',
      'sync-quiesce',
      'access-quiesce',
      'family-quiesce',
      'conflicts-quiesce',
      'settings-quiesce',
    ]);
    expect(events.indexOf('replace')).toBeGreaterThan(events.indexOf('conflicts-quiesce'));
    expect(events.indexOf('backup')).toBeGreaterThan(events.indexOf('settings-quiesce'));
    expect(events.indexOf('backup')).toBeLessThan(events.indexOf('replace'));
    expect(backup.downloadFinalCopy).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en', theme: 'terminal' }),
    );
    expect(events).toContain('concurrent-write-blocked');
    expect(events).not.toContain('concurrent-write-resurrected');
    expect(events.filter((event) => event === 'repo-reset')).toHaveLength(6);
    expect(events.at(-1)).toBe('broadcast');
  });

  it('delegates receipt deletion and durable fence release to one final transaction', async () => {
    const receiptKey = accountClosureStorageKeyForOwner('owner-a');
    const finalize = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        LocalAccountDataService,
        { provide: LOCAL_ACCOUNT_FENCE, useValue: { activate: vi.fn(), finalize } },
        { provide: LOCAL_ACCOUNT_STORAGE, useValue: {} },
        { provide: LOCAL_ACCOUNT_BROADCAST, useValue: {} },
        { provide: LOCAL_ACCOUNT_BACKUP, useValue: {} },
        { provide: TreesRepo, useValue: {} },
        { provide: NodesRepo, useValue: {} },
        { provide: CheckinsRepo, useValue: {} },
        { provide: SessionsRepo, useValue: {} },
        { provide: HarvestsRepo, useValue: {} },
        { provide: PreservesRepo, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: SyncService, useValue: {} },
        { provide: AccessService, useValue: {} },
        { provide: FamilyService, useValue: {} },
        { provide: SyncConflictStore, useValue: {} },
      ],
    });

    await TestBed.inject(LocalAccountDataService).finalize(receiptKey);

    expect(finalize).toHaveBeenCalledWith(receiptKey);
  });
});
