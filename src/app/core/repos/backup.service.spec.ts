import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onLocalWrite, type DbChangeMessage } from '../db/broadcast';
import type { Tree, TreeNode } from '../db/schema';
import { SyncService } from '../sync/sync.service';
import { BackupService } from './backup.service';
import { CheckinsRepo } from './checkins.repo';
import {
  FOREST_REPLACEMENT_STORAGE,
  ForestMutationsService,
  type ForestReplacementStorage,
} from './forest-mutations.service';
import { HarvestsRepo } from './harvests.repo';
import { NodesRepo } from './nodes.repo';
import { PreservesRepo } from './preserves.repo';
import { SessionsRepo } from './sessions.repo';
import { SettingsService } from './settings.service';
import { TreesRepo } from './trees.repo';

const NOW = 1_800_000_000_000;

function tree(id: string): Omit<Tree, 'heartId'> {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    name: id,
    accent: 'moss',
    order: 10,
    currentNodeId: `${id}-root`,
    archivedAt: null,
  };
}

function node(id: string, treeId: string): TreeNode {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    treeId,
    parentId: null,
    title: id,
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
  };
}

function legacyEnvelope(): string {
  return JSON.stringify({
    app: 'rodemap2u',
    schemaVersion: 12,
    exportedAt: '2026-08-19T00:00:00.000Z',
    data: {
      trees: [tree('restored')],
      nodes: [node('restored-root', 'restored')],
      checkins: [],
      sessions: [],
      settings: null,
    },
  });
}

class RepoDouble<T extends { id: string }> {
  private readonly records = signal<ReadonlyMap<string, T>>(new Map());
  readonly byId = this.records.asReadonly();
  readonly resetTo = vi.fn((rows: T[]) =>
    this.records.set(new Map(rows.map((row) => [row.id, row]))),
  );
}

function replacementStorage(
  replace: ForestReplacementStorage['replace'],
): ForestReplacementStorage {
  return { replace, replaceIfEmpty: vi.fn(async () => false) };
}

function configure(
  storage: ForestReplacementStorage,
  assertImport = vi.fn(),
): {
  service: BackupService;
  repos: RepoDouble<{ id: string }>[];
  assertImport: ReturnType<typeof vi.fn>;
  settings: { settings: ReturnType<typeof signal>; patch: ReturnType<typeof vi.fn> };
  sync: { noteRestore: ReturnType<typeof vi.fn> };
} {
  const repos = Array.from({ length: 6 }, () => new RepoDouble<{ id: string }>());
  const settings = { settings: signal({}), patch: vi.fn(async () => undefined) };
  const sync = { noteRestore: vi.fn(async () => undefined) };
  TestBed.configureTestingModule({
    providers: [
      BackupService,
      { provide: TreesRepo, useValue: repos[0] },
      { provide: NodesRepo, useValue: repos[1] },
      { provide: CheckinsRepo, useValue: repos[2] },
      { provide: SessionsRepo, useValue: repos[3] },
      { provide: HarvestsRepo, useValue: repos[4] },
      { provide: PreservesRepo, useValue: repos[5] },
      { provide: SettingsService, useValue: settings },
      { provide: SyncService, useValue: sync },
      { provide: ForestMutationsService, useValue: { assertImport } },
      { provide: FOREST_REPLACEMENT_STORAGE, useValue: storage },
    ],
  });
  return {
    service: TestBed.inject(BackupService),
    repos,
    assertImport,
    settings,
    sync,
  };
}

describe('commercial backup replacement', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('migrates and preflights once, then resets memory and broadcasts only after commit', async () => {
    let release!: () => void;
    const replace = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { service, repos, assertImport, settings, sync } = configure(replacementStorage(replace));
    const download = vi.spyOn(service, 'download').mockResolvedValue();
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    const pending = service.importReplace(legacyEnvelope());
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));

    expect(assertImport).toHaveBeenCalledTimes(1);
    const [migratedTrees, migratedNodes] = assertImport.mock.calls[0];
    expect(migratedTrees[0].heartId).toBe('restored-root');
    expect(migratedNodes[0].id).toBe('restored-root');
    expect(download).toHaveBeenCalledWith('roadmap2u-pre-import', { recordCopy: false });
    expect(repos.every((repo) => repo.resetTo.mock.calls.length === 0)).toBe(true);
    expect(settings.patch).not.toHaveBeenCalled();
    expect(messages).toEqual([]);

    release();
    await pending;

    expect(repos.every((repo) => repo.resetTo.mock.calls.length === 1)).toBe(true);
    expect(settings.patch).toHaveBeenCalledOnce();
    expect(settings.patch.mock.calls[0][0]).toEqual(
      expect.objectContaining({ lastBackupAt: expect.any(Number) }),
    );
    expect(sync.noteRestore).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      {
        store: 'trees',
        ids: ['restored'],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
      {
        store: 'nodes',
        ids: ['restored-root'],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
      {
        store: 'checkins',
        ids: [],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
      {
        store: 'sessions',
        ids: [],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
      {
        store: 'harvests',
        ids: [],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
      {
        store: 'preserves',
        ids: [],
        reset: true,
        mutationGroupId: expect.stringMatching(/^mg-[0-9a-f-]{36}$/),
      },
    ]);
    expect(new Set(messages.map((message) => message.mutationGroupId)).size).toBe(1);
    stop();
  });

  it('does not download, replace, reset, or broadcast when aggregate preflight rejects', async () => {
    const denial = new Error('ACTIVE_TREE_LIMIT');
    const assertImport = vi.fn(() => {
      throw denial;
    });
    const replace = vi.fn(async () => undefined);
    const { service, repos, settings, sync } = configure(replacementStorage(replace), assertImport);
    const download = vi.spyOn(service, 'download').mockResolvedValue();
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    await expect(service.importReplace(legacyEnvelope())).rejects.toBe(denial);

    expect(assertImport).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(repos.every((repo) => repo.resetTo.mock.calls.length === 0)).toBe(true);
    expect(settings.patch).not.toHaveBeenCalled();
    expect(sync.noteRestore).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    stop();
  });

  it('keeps application state unchanged when the atomic replacement aborts', async () => {
    const failure = new Error('synthetic replace abort');
    const replace = vi.fn(async () => Promise.reject(failure));
    const { service, repos, settings, sync } = configure(replacementStorage(replace));
    vi.spyOn(service, 'download').mockResolvedValue();
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    await expect(service.importReplace(legacyEnvelope())).rejects.toBe(failure);

    expect(repos.every((repo) => repo.resetTo.mock.calls.length === 0)).toBe(true);
    expect(settings.patch).not.toHaveBeenCalled();
    expect(sync.noteRestore).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    stop();
  });
});
