import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT, type ApiClient } from '../api/api-client';
import {
  ApiError,
  CONTRACT_VERSION,
  type ApiErrorCode,
  type SyncPushPayload,
  type SyncRecord,
} from '../api/contracts';
import { AuthService } from '../auth/auth.service';
import { broadcastChange } from '../db/broadcast';
import { newSyncBase, type SyncBase, type Tree, type TreeNode } from '../db/schema';
import { CheckinsRepo } from '../repos/checkins.repo';
import { HarvestsRepo } from '../repos/harvests.repo';
import { NodesRepo } from '../repos/nodes.repo';
import { PreservesRepo } from '../repos/preserves.repo';
import { SessionsRepo } from '../repos/sessions.repo';
import { TreesRepo } from '../repos/trees.repo';
import {
  SYNC_CONFLICT_RUNTIME,
  SYNC_CONFLICT_STORAGE,
  SyncConflictStore,
  type SyncConflictStorage,
} from './sync-conflict.store';
import { SyncService } from './sync.service';

const NOW = 1_800_000_000_000;

function tree(id: string, updatedAt = NOW, rev = 1): Tree {
  return {
    ...newSyncBase(NOW),
    id,
    rev,
    updatedAt,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: `${id}-heart`,
    heartId: `${id}-heart`,
    archivedAt: null,
  };
}

function node(id: string, treeId: string, updatedAt = NOW, rev = 1): TreeNode {
  return {
    ...newSyncBase(NOW),
    id,
    rev,
    updatedAt,
    treeId,
    parentId: null,
    title: `private-${id}`,
    note: `private-note-${id}`,
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
  };
}

class RepoDouble<T extends SyncBase> {
  private readonly rows = signal<ReadonlyMap<string, T>>(new Map());
  readonly byId = this.rows.asReadonly();

  constructor(records: readonly T[] = []) {
    this.reset(records);
  }

  reset(records: readonly T[]): void {
    this.rows.set(new Map(records.map((record) => [record.id, record])));
  }

  applyExternal(record: T): void {
    this.rows.update((current) => new Map(current).set(record.id, record));
  }
}

function memoryConflictStorage(): SyncConflictStorage {
  const rows = new Map<string, unknown>();
  return {
    read: async (key) => structuredClone(rows.get(key) ?? null),
    write: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
  };
}

function payloadRecords(payload: SyncPushPayload): SyncRecord[] {
  return 'records' in payload
    ? payload.records
    : payload.mutationGroups.flatMap((group) => group.records);
}

function configure(input: {
  trees?: Tree[];
  nodes?: TreeNode[];
  pushSync: ApiClient['pushSync'];
}): {
  service: SyncService;
  conflicts: SyncConflictStore;
  trees: RepoDouble<Tree>;
  nodes: RepoDouble<TreeNode>;
} {
  const trees = new RepoDouble(input.trees);
  const nodes = new RepoDouble(input.nodes);
  const empty = new RepoDouble<SyncBase>();
  const authUser = signal({ userId: 'owner-a' });
  const api = {
    pushSync: input.pushSync,
    getSyncChanges: vi.fn(async () => ({ changes: [], cursor: 'cursor-1', more: false })),
  } as unknown as ApiClient;
  TestBed.configureTestingModule({
    providers: [
      SyncService,
      SyncConflictStore,
      { provide: API_CLIENT, useValue: api },
      { provide: AuthService, useValue: { user: authUser } },
      { provide: TreesRepo, useValue: trees },
      { provide: NodesRepo, useValue: nodes },
      { provide: CheckinsRepo, useValue: empty },
      { provide: SessionsRepo, useValue: empty },
      { provide: HarvestsRepo, useValue: empty },
      { provide: PreservesRepo, useValue: empty },
      { provide: SYNC_CONFLICT_STORAGE, useValue: memoryConflictStorage() },
      { provide: SYNC_CONFLICT_RUNTIME, useValue: { now: () => NOW } },
    ],
  });
  return {
    service: TestBed.inject(SyncService),
    conflicts: TestBed.inject(SyncConflictStore),
    trees,
    nodes,
  };
}

const BLOCKING_CODES: ApiErrorCode[] = [
  'QUOTA_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'SYNC_CLIENT_UPGRADE_REQUIRED',
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
  'SYNC_SCHEMA_INVALID',
];

describe('commercial sync conflicts', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('merges pending mutation memberships by transitive connected component', () => {
    const { service } = configure({
      pushSync: vi.fn<ApiClient['pushSync']>(),
    });
    type Ref = { store: 'nodes'; id: string };
    const internal = service as unknown as {
      pendingGroups: Map<string, Map<string, Ref>>;
      rememberMutation(groupId: string, refs: readonly Ref[]): void;
    };
    internal.pendingGroups.set(
      'g1',
      new Map([
        ['nodes:A', { store: 'nodes', id: 'A' }],
        ['nodes:B', { store: 'nodes', id: 'B' }],
      ]),
    );
    internal.pendingGroups.set(
      'g2',
      new Map([
        ['nodes:B', { store: 'nodes', id: 'B' }],
        ['nodes:C', { store: 'nodes', id: 'C' }],
      ]),
    );

    internal.rememberMutation('g3', [{ store: 'nodes', id: 'A' }]);

    expect([...internal.pendingGroups].map(([id, refs]) => [id, [...refs.keys()].sort()])).toEqual([
      ['g3', ['nodes:A', 'nodes:B', 'nodes:C']],
    ]);
  });

  it.each(BLOCKING_CODES)(
    'keeps a %s group pending and explainable until retry succeeds',
    async (code) => {
      const pushSync = vi
        .fn<ApiClient['pushSync']>()
        .mockRejectedValueOnce(new ApiError(code))
        .mockImplementationOnce(async (payload) => ({
          applied: payloadRecords(payload).map((entry) => entry.record.id),
          rejected: [],
          serverRecords: [],
        }));
      const { service, conflicts, trees } = configure({ trees: [tree('tree-a')], pushSync });

      await expect(service.connect()).resolves.toBe(false);

      expect(trees.byId().has('tree-a')).toBe(true);
      expect(conflicts.conflicts()).toEqual([
        expect.objectContaining({
          code,
          state: 'pending',
          recordRefs: [{ store: 'trees', id: 'tree-a', rev: 1, updatedAt: NOW }],
          actions: ['retry', 'archive-delete', 'local-only'],
        }),
      ]);
      expect(JSON.stringify(conflicts.conflicts())).not.toMatch(/private|note|force-win/i);

      await expect(service.syncNow()).resolves.toBe(true);

      expect(pushSync).toHaveBeenCalledTimes(2);
      expect(payloadRecords(pushSync.mock.calls[1][0]).map((entry) => entry.record.id)).toEqual([
        'tree-a',
      ]);
      expect(conflicts.conflicts()).toEqual([]);
    },
  );

  it('persists a commercial rejection returned in the push result', async () => {
    const pushSync = vi
      .fn<ApiClient['pushSync']>()
      .mockResolvedValueOnce({
        applied: [],
        rejected: [{ id: 'tree-a', reason: 'QUOTA_EXCEEDED' }] as never,
        serverRecords: [],
      })
      .mockImplementationOnce(async (payload) => ({
        applied: payloadRecords(payload).map((entry) => entry.record.id),
        rejected: [],
        serverRecords: [],
      }));
    const { service, conflicts } = configure({ trees: [tree('tree-a')], pushSync });

    await expect(service.connect()).resolves.toBe(false);

    expect(conflicts.conflicts()).toEqual([
      expect.objectContaining({
        code: 'QUOTA_EXCEEDED',
        state: 'pending',
        recordRefs: [{ store: 'trees', id: 'tree-a', rev: 1, updatedAt: NOW }],
      }),
    ]);

    await expect(service.syncNow()).resolves.toBe(true);
    expect(payloadRecords(pushSync.mock.calls[1][0])).toEqual([
      { store: 'trees', record: tree('tree-a') },
    ]);
  });

  it('resolves one conflict as local-only without deleting it or suppressing another record', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const pushSync = vi.fn<ApiClient['pushSync']>(async (payload) => ({
      applied: payloadRecords(payload).map((entry) => entry.record.id),
      rejected: [],
      serverRecords: [],
    }));
    const { service, conflicts, trees } = configure({
      trees: [tree('tree-local', NOW - 1), tree('tree-pending', NOW - 1)],
      pushSync,
    });
    await conflicts.open('owner-a');
    const conflict = await conflicts.record('owner-a', {
      mutationGroupId: 'mg-local',
      code: 'QUOTA_EXCEEDED',
      recordRefs: [{ store: 'trees', id: 'tree-local', rev: 1, updatedAt: NOW - 1 }],
    });

    const resolution = service as SyncService & {
      resolveConflict(id: string, action: 'retry' | 'local-only'): Promise<boolean>;
    };
    await expect(resolution.resolveConflict(conflict.id, 'local-only')).resolves.toBe(true);
    await expect(service.connect()).resolves.toBe(true);

    expect(trees.byId().has('tree-local')).toBe(true);
    expect(conflicts.conflicts()).toEqual([
      expect.objectContaining({ id: conflict.id, state: 'local-only' }),
    ]);
    expect(payloadRecords(pushSync.mock.calls[0][0]).map((entry) => entry.record.id)).toEqual([
      'tree-pending',
    ]);

    trees.reset([tree('tree-local', NOW + 1, 2), tree('tree-pending', NOW - 1)]);
    await expect(service.syncNow()).resolves.toBe(true);

    expect(payloadRecords(pushSync.mock.calls[1][0]).map((entry) => entry.record.id)).toEqual([
      'tree-local',
    ]);
    expect(conflicts.conflicts()).toEqual([
      expect.objectContaining({ id: conflict.id, state: 'local-only' }),
    ]);
  });

  it('never retries an atomically rejected group as a subset', async () => {
    const cloudTree = tree('tree-a', NOW + 1, 2);
    const pushSync = vi
      .fn<ApiClient['pushSync']>()
      .mockResolvedValueOnce({
        applied: [],
        rejected: [{ id: 'tree-a', reason: 'STALE_REV' }],
        serverRecords: [{ store: 'trees', record: cloudTree }],
      })
      .mockImplementationOnce(async (payload) => ({
        applied: payloadRecords(payload).map((entry) => entry.record.id),
        rejected: [],
        serverRecords: [],
      }));
    const { service } = configure({
      trees: [tree('tree-a', 0)],
      nodes: [node('heart-a', 'tree-a', 0)],
      pushSync,
    });
    await service.init();
    broadcastChange({ store: 'trees', ids: ['tree-a'], mutationGroupId: 'mg-tree-heart' });
    broadcastChange({ store: 'nodes', ids: ['heart-a'], mutationGroupId: 'mg-tree-heart' });

    await expect(service.connect()).resolves.toBe(false);
    await expect(service.syncNow()).resolves.toBe(true);

    expect(pushSync).toHaveBeenCalledTimes(2);
    expect(pushSync.mock.calls[1][0]).toEqual({
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-tree-heart',
          expectedCount: 2,
          records: [
            { store: 'nodes', record: node('heart-a', 'tree-a', 0) },
            { store: 'trees', record: tree('tree-a', 0) },
          ],
        },
      ],
    });
  });

  it('keeps every member dirty when a restore retry is rejected again', async () => {
    const pushSync = vi
      .fn<ApiClient['pushSync']>()
      .mockResolvedValueOnce({
        applied: [],
        rejected: [{ id: 'tree-a', reason: 'STALE_REV' }],
        serverRecords: [{ store: 'trees', record: tree('tree-a', NOW + 1, 2) }],
      })
      .mockResolvedValueOnce({
        applied: [],
        rejected: [{ id: 'tree-a', reason: 'STALE_REV' }],
        serverRecords: [{ store: 'trees', record: tree('tree-a', NOW + 2, 4) }],
      })
      .mockImplementationOnce(async (payload) => ({
        applied: payloadRecords(payload).map((entry) => entry.record.id),
        rejected: [],
        serverRecords: [],
      }));
    const { service } = configure({
      trees: [tree('tree-a', 0)],
      nodes: [node('heart-a', 'tree-a', 0)],
      pushSync,
    });
    await service.init();
    broadcastChange({ store: 'trees', ids: ['tree-a'], mutationGroupId: 'mg-restore-tree' });
    broadcastChange({ store: 'nodes', ids: ['heart-a'], mutationGroupId: 'mg-restore-tree' });
    await service.noteRestore();

    await expect(service.connect()).resolves.toBe(false);
    await expect(service.syncNow()).resolves.toBe(true);

    expect(pushSync.mock.calls[2][0]).toMatchObject({
      mutationGroups: [
        {
          id: 'mg-restore-tree',
          expectedCount: 2,
          records: [
            { store: 'nodes', record: expect.objectContaining({ id: 'heart-a' }) },
            { store: 'trees', record: expect.objectContaining({ id: 'tree-a' }) },
          ],
        },
      ],
    });
  });

  it('does not settle a restore group from a partial first response', async () => {
    const pushSync = vi
      .fn<ApiClient['pushSync']>()
      .mockResolvedValueOnce({ applied: ['tree-a'], rejected: [], serverRecords: [] })
      .mockImplementationOnce(async (payload) => ({
        applied: payloadRecords(payload).map((entry) => entry.record.id),
        rejected: [],
        serverRecords: [],
      }));
    const { service } = configure({
      trees: [tree('tree-a', 0)],
      nodes: [node('heart-a', 'tree-a', 0)],
      pushSync,
    });
    await service.init();
    broadcastChange({ store: 'trees', ids: ['tree-a'], mutationGroupId: 'mg-partial-first' });
    broadcastChange({ store: 'nodes', ids: ['heart-a'], mutationGroupId: 'mg-partial-first' });
    await service.noteRestore();

    await expect(service.connect()).resolves.toBe(false);
    await expect(service.syncNow()).resolves.toBe(true);

    expect(pushSync.mock.calls[1][0]).toMatchObject({
      mutationGroups: [
        {
          id: 'mg-partial-first',
          expectedCount: 2,
        },
      ],
    });
  });

  it('does not settle a restore retry from a partial second response', async () => {
    const pushSync = vi
      .fn<ApiClient['pushSync']>()
      .mockResolvedValueOnce({
        applied: [],
        rejected: [{ id: 'tree-a', reason: 'STALE_REV' }],
        serverRecords: [{ store: 'trees', record: tree('tree-a', NOW + 1, 2) }],
      })
      .mockResolvedValueOnce({ applied: ['tree-a'], rejected: [], serverRecords: [] })
      .mockImplementationOnce(async (payload) => ({
        applied: payloadRecords(payload).map((entry) => entry.record.id),
        rejected: [],
        serverRecords: [],
      }));
    const { service } = configure({
      trees: [tree('tree-a', 0)],
      nodes: [node('heart-a', 'tree-a', 0)],
      pushSync,
    });
    await service.init();
    broadcastChange({ store: 'trees', ids: ['tree-a'], mutationGroupId: 'mg-partial-retry' });
    broadcastChange({ store: 'nodes', ids: ['heart-a'], mutationGroupId: 'mg-partial-retry' });
    await service.noteRestore();

    await expect(service.connect()).resolves.toBe(false);
    await expect(service.syncNow()).resolves.toBe(true);

    expect(pushSync.mock.calls[2][0]).toMatchObject({
      mutationGroups: [
        {
          id: 'mg-partial-retry',
          expectedCount: 2,
        },
      ],
    });
  });

  it('carries one explicit cross-store write into one v2 payload group', async () => {
    const pushSync = vi.fn<ApiClient['pushSync']>(async (payload) => ({
      applied: payloadRecords(payload).map((entry) => entry.record.id),
      rejected: [],
      serverRecords: [],
    }));
    const { service } = configure({
      trees: [tree('tree-a', 0)],
      nodes: [node('heart-a', 'tree-a', 0)],
      pushSync,
    });
    await service.init();
    broadcastChange({ store: 'trees', ids: ['tree-a'], mutationGroupId: 'mg-tree-heart' });
    broadcastChange({ store: 'nodes', ids: ['heart-a'], mutationGroupId: 'mg-tree-heart' });

    await expect(service.connect()).resolves.toBe(true);

    expect(pushSync).toHaveBeenCalledWith({
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [
        {
          id: 'mg-tree-heart',
          expectedCount: 2,
          records: [
            { store: 'nodes', record: node('heart-a', 'tree-a', 0) },
            { store: 'trees', record: tree('tree-a', 0) },
          ],
        },
      ],
    });
  });
});
