import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_CONFLICT_RUNTIME,
  SYNC_CONFLICT_STORAGE,
  SyncConflictStore,
  canForceWin,
  type SyncConflictRecordRef,
  type SyncConflictStorage,
} from './sync-conflict.store';

const NOW = 1_800_000_000_000;

function ref(
  store: SyncConflictRecordRef['store'],
  id: string,
  rev = 1,
  updatedAt = NOW,
): SyncConflictRecordRef {
  return { store, id, rev, updatedAt };
}

function memoryStorage(): SyncConflictStorage & {
  rows: Map<string, unknown>;
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, unknown>();
  return {
    rows,
    read: vi.fn(async (key: string) => structuredClone(rows.get(key) ?? null)),
    write: vi.fn(async (key: string, value: unknown) => {
      rows.set(key, structuredClone(value));
    }),
  };
}

function configure(storage: SyncConflictStorage): SyncConflictStore {
  TestBed.configureTestingModule({
    providers: [
      SyncConflictStore,
      { provide: SYNC_CONFLICT_STORAGE, useValue: storage },
      { provide: SYNC_CONFLICT_RUNTIME, useValue: { now: () => NOW } },
    ],
  });
  return TestBed.inject(SyncConflictStore);
}

describe('SyncConflictStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('persists a sanitized, explainable blocked group across reloads', async () => {
    const storage = memoryStorage();
    const first = configure(storage);
    await first.open('rocio@example.com');

    const conflict = await first.record('rocio@example.com', {
      mutationGroupId: 'mg-safe-1',
      code: 'QUOTA_EXCEEDED',
      recordRefs: [
        ref('trees', '68bd91f8-6515-4c88-b8d7-51fd250406f1'),
        ref('nodes', 'd04f122d-2cf6-4624-a58c-31b33134fcee'),
      ],
    });

    expect(conflict).toMatchObject({
      mutationGroupId: 'mg-safe-1',
      code: 'QUOTA_EXCEEDED',
      state: 'pending',
      actions: ['retry', 'archive-delete', 'local-only'],
    });
    expect(conflict.actions).not.toContain('force-win');
    const persisted = JSON.stringify([...storage.rows.entries()]);
    expect(persisted).not.toContain('rocio@example.com');
    expect(persisted).not.toMatch(/title|note|email|displayName/i);

    TestBed.resetTestingModule();
    const reloaded = configure(storage);
    await reloaded.open('rocio@example.com');
    expect(reloaded.conflicts()).toEqual([conflict]);
  });

  it('isolates conflicts by an opaque auth scope', async () => {
    const storage = memoryStorage();
    const service = configure(storage);
    await service.open('owner-a');
    await service.record('owner-a', {
      mutationGroupId: 'mg-a',
      code: 'CAPABILITY_REQUIRED',
      recordRefs: [ref('nodes', 'node-a')],
    });

    await service.open('owner-b');
    expect(service.conflicts()).toEqual([]);
    await service.record('owner-b', {
      mutationGroupId: 'mg-b',
      code: 'SYNC_CLIENT_UPGRADE_REQUIRED',
      recordRefs: [ref('trees', 'tree-b')],
    });

    await service.open('owner-a');
    expect(service.conflicts().map((conflict) => conflict.mutationGroupId)).toEqual(['mg-a']);
    expect([...storage.rows.keys()].every((key) => !key.includes('owner-a'))).toBe(true);
  });

  it('coalesces concurrent hydration of the same auth scope', async () => {
    let release!: () => void;
    const storage: SyncConflictStorage = {
      read: vi.fn(() => new Promise<null>((resolve) => (release = () => resolve(null)))),
      write: vi.fn(async () => undefined),
    };
    const service = configure(storage);

    const first = service.open('owner-a');
    let secondSettled = false;
    const second = service.open('owner-a').then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(storage.read).toHaveBeenCalledTimes(1);
    expect(secondSettled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
  });

  it('serializes concurrent persistence so an older envelope cannot win last', async () => {
    const rows = new Map<string, unknown>();
    let releaseFirstWrite!: () => void;
    let writeCount = 0;
    const storage: SyncConflictStorage = {
      read: vi.fn(async (key: string) => structuredClone(rows.get(key) ?? null)),
      write: vi.fn(async (key: string, value: unknown) => {
        writeCount += 1;
        if (writeCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        rows.set(key, structuredClone(value));
      }),
    };
    const service = configure(storage);
    await service.open('owner-a');

    const first = service.record('owner-a', {
      mutationGroupId: 'mg-first',
      code: 'QUOTA_EXCEEDED',
      recordRefs: [ref('nodes', 'node-first')],
    });
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledTimes(1));
    const second = service.record('owner-a', {
      mutationGroupId: 'mg-second',
      code: 'CAPABILITY_REQUIRED',
      recordRefs: [ref('nodes', 'node-second')],
    });
    await Promise.resolve();

    releaseFirstWrite();
    await Promise.all([first, second]);

    TestBed.resetTestingModule();
    const reloaded = configure(storage);
    await reloaded.open('owner-a');
    expect(reloaded.conflicts().map((conflict) => conflict.mutationGroupId)).toEqual([
      'mg-first',
      'mg-second',
    ]);
  });

  it('keeps a local-only conflict visible and excludes only its own refs', async () => {
    const service = configure(memoryStorage());
    await service.open('owner-a');
    const first = await service.record('owner-a', {
      mutationGroupId: 'mg-local',
      code: 'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
      recordRefs: [ref('nodes', 'node-local', 3, NOW - 1)],
    });
    await service.record('owner-a', {
      mutationGroupId: 'mg-pending',
      code: 'SYNC_SCHEMA_INVALID',
      recordRefs: [ref('nodes', 'node-pending', 1, NOW)],
    });

    await service.resolve('owner-a', first.id, 'local-only');

    expect(service.isLocalOnly('nodes', 'node-local', 3, NOW - 1)).toBe(true);
    expect(service.isLocalOnly('nodes', 'node-local', 4, NOW)).toBe(false);
    expect(service.isLocalOnly('nodes', 'node-pending', 1, NOW)).toBe(false);
    expect(service.conflicts()).toEqual([
      expect.objectContaining({ mutationGroupId: 'mg-local', state: 'local-only' }),
      expect.objectContaining({ mutationGroupId: 'mg-pending', state: 'pending' }),
    ]);

    const storage = memoryStorage();
    TestBed.resetTestingModule();
    const persisted = configure(storage);
    await persisted.open('owner-a');
    const local = await persisted.record('owner-a', {
      mutationGroupId: 'mg-reloaded-local',
      code: 'QUOTA_EXCEEDED',
      recordRefs: [ref('nodes', 'node-reloaded', 7, NOW - 5)],
    });
    await persisted.resolve('owner-a', local.id, 'local-only');

    TestBed.resetTestingModule();
    const reloaded = configure(storage);
    await reloaded.open('owner-a');
    expect(reloaded.isLocalOnly('nodes', 'node-reloaded', 7, NOW - 5)).toBe(true);
    expect(reloaded.isLocalOnly('nodes', 'node-reloaded', 8, NOW)).toBe(false);
  });

  it('allows force-win only for STALE_REV', () => {
    expect(canForceWin('STALE_REV')).toBe(true);
    expect(canForceWin('QUOTA_EXCEEDED')).toBe(false);
    expect(canForceWin('CAPABILITY_REQUIRED')).toBe(false);
    expect(canForceWin('SYNC_SCHEMA_INVALID')).toBe(false);
    expect(canForceWin('SYNC_CLIENT_UPGRADE_REQUIRED')).toBe(false);
  });
});
