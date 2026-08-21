import { Injectable } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncBase } from '../db/schema';
import {
  quiesceAccountClosureWrites,
  resumeAccountClosureWritesLocally,
} from '../db/account-closure-fence';
import {
  RECORDS_STORAGE,
  RecordsRepo,
  type RecordsStorage,
} from './records.repo';

interface TestRow extends SyncBase {
  title: string;
}

const ROW: TestRow = {
  id: 'row-a',
  createdAt: 1,
  updatedAt: 1,
  rev: 1,
  deletedAt: null,
  title: 'before closure',
};

@Injectable()
class TestRecordsRepo extends RecordsRepo<TestRow> {
  protected readonly store = 'nodes' as const;
}

describe('RecordsRepo terminal read quiesce', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => resumeAccountClosureWritesLocally());

  it('does not publish a load that resolves after terminal quiesce', async () => {
    let release!: (rows: TestRow[]) => void;
    const storage: RecordsStorage = {
      read: vi.fn(async () => undefined),
      readAll: vi.fn(() => new Promise<TestRow[]>((resolve) => (release = resolve))),
      write: vi.fn(async () => undefined),
      writeMany: vi.fn(async () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [TestRecordsRepo, { provide: RECORDS_STORAGE, useValue: storage }],
    });
    const repo = TestBed.inject(TestRecordsRepo);

    const loading = repo.load();
    await vi.waitFor(() => expect(storage.readAll).toHaveBeenCalledOnce());
    quiesceAccountClosureWrites();
    release([ROW]);
    await loading;

    expect(repo.byId().size).toBe(0);
  });

  it('does not apply a delayed cross-tab refresh after terminal quiesce', async () => {
    let release!: (row: TestRow | undefined) => void;
    const storage: RecordsStorage = {
      read: vi.fn(() => new Promise<TestRow | undefined>((resolve) => (release = resolve))),
      readAll: vi.fn(async () => []),
      write: vi.fn(async () => undefined),
      writeMany: vi.fn(async () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [TestRecordsRepo, { provide: RECORDS_STORAGE, useValue: storage }],
    });
    const repo = TestBed.inject(TestRecordsRepo);
    repo.resetTo([ROW]);

    const refreshing = repo.refreshFromDisk([ROW.id]);
    await vi.waitFor(() => expect(storage.read).toHaveBeenCalledOnce());
    quiesceAccountClosureWrites();
    release({ ...ROW, rev: 2, updatedAt: 2, title: 'too late' });
    await refreshing;

    expect(repo.byId().get(ROW.id)).toEqual(ROW);
  });
});
