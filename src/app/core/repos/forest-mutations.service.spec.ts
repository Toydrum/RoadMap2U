import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreeAccessSummary } from '../api/contracts';
import { API_CLIENT, type ApiClient } from '../api/api-client';
import { AccessService } from '../access/access.service';
import { type Tree, type TreeNode, newSyncBase } from '../db/schema';
import { onLocalWrite, type DbChangeMessage } from '../db/broadcast';
import { NodesRepo } from './nodes.repo';
import { TreesRepo } from './trees.repo';
import { VisitNodesRepo, VisitTreesRepo } from '../visit/visit-repos';
import { FOREST_MUTATION_STORAGE, type ForestMutationStorage } from './forest-mutations.service';

const NOW = 1_800_000_000_000;

function tree(id: string, overrides: Partial<Tree> = {}): Tree {
  return {
    ...newSyncBase(NOW),
    id,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: `${id}-heart`,
    heartId: `${id}-heart`,
    archivedAt: null,
    ...overrides,
  };
}

function node(id: string, treeId: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    ...newSyncBase(NOW),
    id,
    treeId,
    parentId: `${treeId}-heart`,
    title: id,
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
    ...overrides,
  };
}

function heart(treeId: string): TreeNode {
  return node(`${treeId}-heart`, treeId, { parentId: null });
}

function configure(storage: ForestMutationStorage): { trees: TreesRepo; nodes: NodesRepo } {
  const access = createFreeAccessSummary(NOW);
  TestBed.configureTestingModule({
    providers: [
      TreesRepo,
      NodesRepo,
      { provide: AccessService, useValue: { access: () => access, leaseState: () => 'valid' } },
      { provide: FOREST_MUTATION_STORAGE, useValue: storage },
    ],
  });
  return { trees: TestBed.inject(TreesRepo), nodes: TestBed.inject(NodesRepo) };
}

describe('atomic forest mutations', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('publishes a newborn tree and its heart only after one cross-store commit', async () => {
    let release!: () => void;
    const commit = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { trees, nodes } = configure({ commit });
    const writes: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => writes.push(message));

    const pending = trees.create('Mi camino', 'sage');

    expect(trees.byId().size).toBe(0);
    expect(nodes.byId().size).toBe(0);
    expect(writes).toEqual([]);

    release();
    const newborn = await pending;
    const newbornHeart = nodes.byId().get(newborn.heartId!);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith([
      { store: 'trees', rows: [newborn] },
      { store: 'nodes', rows: [newbornHeart] },
    ]);
    expect(newborn.currentNodeId).toBe(newborn.heartId);
    expect(newbornHeart).toMatchObject({
      id: newborn.heartId,
      treeId: newborn.id,
      parentId: null,
      title: 'Mi camino',
      archivedAt: null,
      deletedAt: null,
    });
    expect(writes).toEqual([
      { store: 'trees', ids: [newborn.id] },
      { store: 'nodes', ids: [newborn.heartId!] },
    ]);
    stop();
  });

  it('keeps both in-memory stores untouched when the transaction aborts', async () => {
    const failure = new Error('synthetic transaction abort');
    const { trees, nodes } = configure({ commit: vi.fn(async () => Promise.reject(failure)) });

    await expect(trees.create('No nace', 'moss')).rejects.toBe(failure);

    expect(trees.byId().size).toBe(0);
    expect(nodes.byId().size).toBe(0);
  });

  it('preserves a memory-only session when the storage port completes without disk', async () => {
    const { trees, nodes } = configure({ commit: vi.fn(async () => undefined) });

    const newborn = await trees.create('Vive en memoria', 'sky');

    expect(trees.byId().get(newborn.id)).toBe(newborn);
    expect(nodes.byId().get(newborn.heartId!)).toBeDefined();
  });

  it('rejects a third Free tree before writing either store', async () => {
    const commit = vi.fn(async () => undefined);
    const { trees, nodes } = configure({ commit });
    trees.resetTo([tree('one'), tree('two', { order: 20 })]);
    nodes.resetTo([heart('one'), heart('two')]);

    await expect(trees.create('Tres', 'clay')).rejects.toMatchObject({
      decision: { reason: 'ACTIVE_TREE_LIMIT' },
    });

    expect(commit).not.toHaveBeenCalled();
    expect(trees.byId().size).toBe(2);
    expect(nodes.byId().size).toBe(2);
  });

  it('preflights plantMany as one aggregate and writes none when the batch exceeds Free', async () => {
    const { trees, nodes } = configure({ commit: vi.fn(async () => undefined) });
    const oak = tree('oak');
    trees.resetTo([oak]);
    nodes.resetTo([
      heart('oak'),
      ...Array.from({ length: 9 }, (_, index) => node(`b${index}`, 'oak')),
    ]);

    await expect(
      nodes.plantMany('oak', [
        { parentId: oak.heartId, title: 'Diez' },
        { parentId: oak.heartId, title: 'Once' },
      ]),
    ).rejects.toMatchObject({
      decision: { reason: 'VISIBLE_BRANCH_LIMIT', current: 9, projected: 11 },
    });

    expect(nodes.byId().size).toBe(10);
  });

  it('preflights branch alternatives as one aggregate before changing the parent', async () => {
    const { trees, nodes } = configure({ commit: vi.fn(async () => undefined) });
    const oak = tree('oak');
    const parent = node('parent', 'oak', { status: 'growing' });
    trees.resetTo([oak]);
    nodes.resetTo([
      heart('oak'),
      parent,
      ...Array.from({ length: 8 }, (_, index) => node(`b${index}`, 'oak')),
    ]);

    await expect(
      nodes.branch(parent, [{ title: 'Camino A' }, { title: 'Camino B' }]),
    ).rejects.toMatchObject({
      decision: { reason: 'VISIBLE_BRANCH_LIMIT', current: 9, projected: 11 },
    });

    expect(nodes.byId().get(parent.id)?.status).toBe('growing');
    expect(nodes.byId().size).toBe(10);
  });

  it('preflights an unarchive batch atomically and restores none when all would not fit', async () => {
    const { trees, nodes } = configure({ commit: vi.fn(async () => undefined) });
    const oak = tree('oak');
    const archived = [
      node('sleep-1', 'oak', { archivedAt: NOW }),
      node('sleep-2', 'oak', { archivedAt: NOW }),
    ];
    trees.resetTo([oak]);
    nodes.resetTo([
      heart('oak'),
      ...Array.from({ length: 9 }, (_, index) => node(`b${index}`, 'oak')),
      ...archived,
    ]);

    await expect(nodes.unarchiveMany(archived)).rejects.toMatchObject({
      decision: { reason: 'VISIBLE_BRANCH_LIMIT', current: 9, projected: 11 },
    });

    expect(nodes.byId().get('sleep-1')?.archivedAt).toBe(NOW);
    expect(nodes.byId().get('sleep-2')?.archivedAt).toBe(NOW);
  });

  it('validates every visible branch before restoring an archived tree', async () => {
    const { trees, nodes } = configure({ commit: vi.fn(async () => undefined) });
    const archived = tree('oak', { archivedAt: NOW });
    trees.resetTo([archived]);
    nodes.resetTo([
      heart('oak'),
      ...Array.from({ length: 11 }, (_, index) => node(`b${index}`, 'oak')),
    ]);

    await expect(trees.restore(archived)).rejects.toMatchObject({
      decision: { reason: 'VISIBLE_BRANCH_LIMIT', current: 0, projected: 11 },
    });

    expect(trees.byId().get('oak')?.archivedAt).toBe(NOW);
  });

  it('leaves delegated visit growth to the visited owner server policy', async () => {
    const pushSyncFor = vi.fn(
      async (_ownerId: string, request: Parameters<ApiClient['pushSyncFor']>[1]) => {
        const records =
          'records' in request
            ? request.records
            : request.mutationGroups.flatMap((group) => group.records);
        return {
          applied: records.map((record) => record.record.id),
          rejected: [],
          serverRecords: [],
        };
      },
    );
    TestBed.configureTestingModule({
      providers: [
        VisitNodesRepo,
        { provide: API_CLIENT, useValue: { pushSyncFor } as unknown as ApiClient },
        {
          provide: AccessService,
          useValue: {
            access: () => createFreeAccessSummary(NOW),
            leaseState: () => 'fallback',
          },
        },
        { provide: FOREST_MUTATION_STORAGE, useValue: { commit: vi.fn(async () => undefined) } },
      ],
    });
    const visited = TestBed.inject(VisitNodesRepo);
    visited.bind('minor-owner', true);
    visited.resetTo([
      heart('oak'),
      ...Array.from({ length: 10 }, (_, index) => node(`b${index}`, 'oak')),
    ]);

    await expect(
      visited.plant('oak', 'oak-heart', { title: 'La autoridad vive en el owner' }),
    ).resolves.toMatchObject({ title: 'La autoridad vive en el owner' });

    expect(pushSyncFor).toHaveBeenCalledTimes(1);
  });

  it('leaves a delegated visit tree restore to the visited owner server policy', async () => {
    const pushSyncFor = vi.fn(async () => ({ applied: ['oak'], rejected: [], serverRecords: [] }));
    TestBed.configureTestingModule({
      providers: [
        VisitTreesRepo,
        { provide: API_CLIENT, useValue: { pushSyncFor } as unknown as ApiClient },
        {
          provide: AccessService,
          useValue: {
            access: () => createFreeAccessSummary(NOW),
            leaseState: () => 'fallback',
          },
        },
        { provide: FOREST_MUTATION_STORAGE, useValue: { commit: vi.fn(async () => undefined) } },
      ],
    });
    const visited = TestBed.inject(VisitTreesRepo);
    const archived = tree('oak', { archivedAt: NOW });
    visited.bind('minor-owner', true);
    visited.resetTo([archived]);

    await expect(visited.restore(archived)).resolves.toBeUndefined();

    expect(pushSyncFor).toHaveBeenCalledTimes(1);
  });
});
