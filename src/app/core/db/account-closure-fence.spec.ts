import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalWritesQuiescedError,
  assertAccountClosureWriteAllowed,
  onAccountClosureQuiesce,
  quiesceAccountClosureWrites,
  resumeAccountClosureWritesLocally,
  runAccountClosureGuardedWrite,
} from './account-closure-fence';
import {
  accountClosureGuardedWriteInDatabase,
  activateAccountClosureFenceInDatabase,
  captureAccountClosureFence,
  commitAccountClosureSnapshotInDatabase,
  deleteAuthIdentitySnapshotInDatabase,
  finalizeAccountClosureFenceInDatabase,
  migrateSchemaIfNeeded,
  sealMigrationInDatabase,
} from './idb';

type Row = Record<string, unknown>;

class SerialRequest<T> {
  readyState: IDBRequestReadyState = 'pending';
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;
}

class SerialState {
  readonly tables = new Map<string, Map<string, Row>>([
    ['meta', new Map()],
    ['nodes', new Map()],
    ['trees', new Map()],
  ]);
  tail: Promise<void> = Promise.resolve();
}

class SerialTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  error: DOMException | null = null;

  private draft = new Map<string, Map<string, Row>>();
  private readonly queuedReads: Array<() => void> = [];
  private readonly queuedMutations: Array<() => void> = [];
  private pendingReads = 0;
  private started = false;
  private finished = false;
  private finishQueued = false;
  private release!: () => void;

  constructor(private readonly state: SerialState) {
    const prior = state.tail;
    const done = new Promise<void>((resolve) => (this.release = resolve));
    state.tail = prior.then(() => done);
    void prior.then(() => this.start());
  }

  objectStore(name: string): IDBObjectStore {
    return {
      get: (key: IDBValidKey) =>
        this.request(() => structuredClone(this.table(name).get(String(key)))) as IDBRequest,
      getAll: () =>
        this.request(() =>
          [...this.table(name).values()].map((row) => structuredClone(row)),
        ) as IDBRequest,
      put: (value: Row) => {
        const mutation = () => {
          const key = name === 'meta' ? value['key'] : value['id'];
          this.table(name).set(String(key), structuredClone(value));
          this.queueFinish();
        };
        if (this.started) mutation();
        else this.queuedMutations.push(mutation);
        return {} as IDBRequest<IDBValidKey>;
      },
      delete: (key: IDBValidKey) => {
        const mutation = () => {
          this.table(name).delete(String(key));
          this.queueFinish();
        };
        if (this.started) mutation();
        else this.queuedMutations.push(mutation);
        return {} as IDBRequest<undefined>;
      },
    } as IDBObjectStore;
  }

  abort(): void {
    if (this.finished) return;
    this.finished = true;
    queueMicrotask(() => {
      this.onabort?.call(this as unknown as IDBTransaction, new Event('abort'));
      this.release();
    });
  }

  private start(): void {
    if (this.finished) return;
    this.draft = new Map(
      [...this.state.tables].map(([name, rows]) => [
        name,
        new Map([...rows].map(([key, row]) => [key, structuredClone(row)])),
      ]),
    );
    this.started = true;
    for (const mutate of this.queuedMutations) mutate();
    for (const deliver of this.queuedReads) queueMicrotask(deliver);
    this.queueFinish();
  }

  private table(name: string): Map<string, Row> {
    const table = this.draft.get(name);
    if (!table) throw new Error(`missing serial store ${name}`);
    return table;
  }

  private request<T>(produce: () => T): SerialRequest<T> {
    const request = new SerialRequest<T>();
    this.pendingReads += 1;
    const deliver = () => {
      if (this.finished) return;
      request.result = produce();
      request.readyState = 'done';
      request.onsuccess?.call(request as unknown as IDBRequest<T>, new Event('success'));
      this.pendingReads -= 1;
      this.queueFinish();
    };
    if (this.started) queueMicrotask(deliver);
    else this.queuedReads.push(deliver);
    return request;
  }

  private queueFinish(): void {
    if (this.finishQueued || this.finished) return;
    this.finishQueued = true;
    queueMicrotask(() => {
      this.finishQueued = false;
      if (this.finished || !this.started || this.pendingReads > 0) return;
      this.finished = true;
      for (const [name, rows] of this.draft) {
        this.state.tables.set(
          name,
          new Map([...rows].map(([key, row]) => [key, structuredClone(row)])),
        );
      }
      this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete'));
      this.release();
    });
  }
}

class SerialConnection {
  constructor(private readonly state: SerialState) {}
  transaction(): IDBTransaction {
    return new SerialTransaction(this.state) as unknown as IDBTransaction;
  }
}

function row(state: SerialState, store: string, key: string): Row | undefined {
  return structuredClone(state.tables.get(store)?.get(key));
}

function closureSnapshot(receiptKey: string, state: 'requested' | 'purging' | 'completed') {
  return {
    key: receiptKey,
    formatVersion: 1 as const,
    receipt: { closureId: 'closure-1', state },
  };
}

describe('terminal account-closure local write fence', () => {
  afterEach(() => resumeAccountClosureWritesLocally());

  it('notifies local listeners before blocking record and user-meta writes', () => {
    const listener = vi.fn();
    const stop = onAccountClosureQuiesce(listener);

    quiesceAccountClosureWrites();

    expect(listener).toHaveBeenCalledOnce();
    expect(() => assertAccountClosureWriteAllowed('nodes', { id: 'node-a' })).toThrow(
      LocalWritesQuiescedError,
    );
    expect(() => assertAccountClosureWriteAllowed('meta', { key: 'sync.state' })).toThrow(
      LocalWritesQuiescedError,
    );
    stop();
  });

  it('blocks generic meta writes; privileged terminal APIs are the only bypass', () => {
    quiesceAccountClosureWrites();

    expect(() =>
      assertAccountClosureWriteAllowed('meta', {
        key: 'account.closure:opaque-scope',
      }),
    ).toThrow(LocalWritesQuiescedError);
    expect(() => assertAccountClosureWriteAllowed('meta', { key: 'auth.identity' })).toThrow(
      LocalWritesQuiescedError,
    );
    expect(() => assertAccountClosureWriteAllowed('meta', { key: 'schema.version' })).toThrow(
      LocalWritesQuiescedError,
    );
  });

  it('rejects a storage completion observed after quiesce before its caller can publish memory', async () => {
    let finishStorage!: () => void;
    let published = false;
    const guarded = runAccountClosureGuardedWrite(
      [{ store: 'nodes', value: { id: 'late-node' } }],
      () => new Promise<void>((resolve) => (finishStorage = resolve)),
    );
    const caller = guarded.then(() => {
      published = true;
    });

    quiesceAccountClosureWrites();
    finishStorage();

    await expect(caller).rejects.toBeInstanceOf(LocalWritesQuiescedError);
    expect(published).toBe(false);
  });

  it('serializes a durable fence across two connections and rejects the stale connection forever', async () => {
    const state = new SerialState();
    const first = new SerialConnection(state) as unknown as IDBDatabase;
    const second = new SerialConnection(state) as unknown as IDBDatabase;
    await Promise.all([captureAccountClosureFence(first), captureAccountClosureFence(second)]);

    const writeBeforeFence = accountClosureGuardedWriteInDatabase(second, ['nodes'], (tx) =>
      tx.objectStore('nodes').put({ id: 'before-fence' }),
    );
    const receiptKey = 'account.closure:test-scope';
    const fence = activateAccountClosureFenceInDatabase(first, receiptKey);
    await Promise.all([writeBeforeFence, fence]);
    expect(row(state, 'nodes', 'before-fence')).toEqual({ id: 'before-fence' });

    await expect(
      accountClosureGuardedWriteInDatabase(second, ['nodes'], (tx) =>
        tx.objectStore('nodes').put({ id: 'after-fence' }),
      ),
    ).rejects.toBeInstanceOf(LocalWritesQuiescedError);
    expect(row(state, 'nodes', 'after-fence')).toBeUndefined();

    const openedDuringFence = new SerialConnection(state) as unknown as IDBDatabase;
    await captureAccountClosureFence(openedDuringFence);

    await finalizeAccountClosureFenceInDatabase(first, receiptKey);
    await expect(
      accountClosureGuardedWriteInDatabase(second, ['nodes'], (tx) =>
        tx.objectStore('nodes').put({ id: 'stale-after-release' }),
      ),
    ).rejects.toBeInstanceOf(LocalWritesQuiescedError);
    await expect(
      accountClosureGuardedWriteInDatabase(openedDuringFence, ['nodes'], (tx) =>
        tx.objectStore('nodes').put({ id: 'opened-during-fence' }),
      ),
    ).rejects.toBeInstanceOf(LocalWritesQuiescedError);

    await accountClosureGuardedWriteInDatabase(first, ['nodes'], (tx) =>
      tx.objectStore('nodes').put({ id: 'finalizer-generation' }),
    );

    const fresh = new SerialConnection(state) as unknown as IDBDatabase;
    await captureAccountClosureFence(fresh);
    await accountClosureGuardedWriteInDatabase(fresh, ['nodes'], (tx) =>
      tx.objectStore('nodes').put({ id: 'fresh-generation' }),
    );
    expect(row(state, 'nodes', 'fresh-generation')).toEqual({ id: 'fresh-generation' });
  });

  it('activates the terminal fence atomically with completed and never lets a stale tab regress it', async () => {
    const state = new SerialState();
    const first = new SerialConnection(state) as unknown as IDBDatabase;
    const stale = new SerialConnection(state) as unknown as IDBDatabase;
    await Promise.all([captureAccountClosureFence(first), captureAccountClosureFence(stale)]);
    const receiptKey = 'account.closure:atomic-terminal';

    await commitAccountClosureSnapshotInDatabase(
      first,
      closureSnapshot(receiptKey, 'purging'),
    );
    await commitAccountClosureSnapshotInDatabase(
      first,
      closureSnapshot(receiptKey, 'completed'),
    );
    const canonical = await commitAccountClosureSnapshotInDatabase(
      stale,
      closureSnapshot(receiptKey, 'requested'),
    );

    expect(canonical).toEqual(closureSnapshot(receiptKey, 'completed'));
    expect(row(state, 'meta', receiptKey)).toEqual(closureSnapshot(receiptKey, 'completed'));
    expect(row(state, 'meta', 'account.closure.fence')).toEqual({
      key: 'account.closure.fence',
      generation: 1,
      active: true,
      receiptKey,
    });
  });

  it('uses a monotonic CAS when two pending responses commit out of order', async () => {
    const state = new SerialState();
    const first = new SerialConnection(state) as unknown as IDBDatabase;
    const second = new SerialConnection(state) as unknown as IDBDatabase;
    await Promise.all([captureAccountClosureFence(first), captureAccountClosureFence(second)]);
    const receiptKey = 'account.closure:pending-cas';

    const purging = commitAccountClosureSnapshotInDatabase(
      first,
      closureSnapshot(receiptKey, 'purging'),
    );
    const staleRequested = commitAccountClosureSnapshotInDatabase(
      second,
      closureSnapshot(receiptKey, 'requested'),
    );

    await expect(purging).resolves.toEqual(closureSnapshot(receiptKey, 'purging'));
    await expect(staleRequested).resolves.toEqual(closureSnapshot(receiptKey, 'purging'));
    expect(row(state, 'meta', receiptKey)).toEqual(closureSnapshot(receiptKey, 'purging'));
  });

  it('never deletes the receipt or releases the fence while auth identity remains', async () => {
    const state = new SerialState();
    const db = new SerialConnection(state) as unknown as IDBDatabase;
    const receiptKey = 'account.closure:test-auth-scope';
    await captureAccountClosureFence(db);
    await accountClosureGuardedWriteInDatabase(db, ['meta'], (tx) => {
      tx.objectStore('meta').put({ key: receiptKey, receipt: { state: 'completed' } });
      tx.objectStore('meta').put({ key: 'auth.identity', user: { userId: 'private' } });
    });
    await activateAccountClosureFenceInDatabase(db, receiptKey);

    await expect(finalizeAccountClosureFenceInDatabase(db, receiptKey)).rejects.toThrow(
      /identity remains/i,
    );

    expect(row(state, 'meta', receiptKey)).toBeTruthy();

    await deleteAuthIdentitySnapshotInDatabase(db);
    await expect(finalizeAccountClosureFenceInDatabase(db, receiptKey)).resolves.toBeUndefined();
  });

  it('prevents an opening tab schema migration from repopulating after fence activation', async () => {
    const state = new SerialState();
    const first = new SerialConnection(state) as unknown as IDBDatabase;
    const second = new SerialConnection(state) as unknown as IDBDatabase;
    const receiptKey = 'account.closure:test-migration';
    await Promise.all([captureAccountClosureFence(first), captureAccountClosureFence(second)]);
    await accountClosureGuardedWriteInDatabase(first, ['trees', 'nodes', 'meta'], (tx) => {
      tx.objectStore('trees').put({ id: 'tree-a', currentNodeId: 'root-a' });
      tx.objectStore('nodes').put({
        id: 'root-a',
        treeId: 'tree-a',
        parentId: null,
        deletedAt: null,
        archivedAt: null,
      });
      tx.objectStore('meta').put({ key: 'schema.version', version: 12 });
    });

    const activating = activateAccountClosureFenceInDatabase(first, receiptKey);
    const migrating = migrateSchemaIfNeeded(second);
    await activating;
    await expect(migrating).rejects.toBeInstanceOf(LocalWritesQuiescedError);

    expect(row(state, 'nodes', 'root-a')).toEqual(expect.objectContaining({ id: 'root-a' }));
  });

  it('prevents a legacy migration sentinel from landing after fence activation', async () => {
    const state = new SerialState();
    const first = new SerialConnection(state) as unknown as IDBDatabase;
    const second = new SerialConnection(state) as unknown as IDBDatabase;
    const receiptKey = 'account.closure:test-legacy-migration';
    await Promise.all([captureAccountClosureFence(first), captureAccountClosureFence(second)]);

    const activating = activateAccountClosureFenceInDatabase(first, receiptKey);
    const sealing = sealMigrationInDatabase(second, 'no-legacy');
    await activating;
    await expect(sealing).rejects.toBeInstanceOf(LocalWritesQuiescedError);

    expect(row(state, 'meta', 'legacy.migratedAt')).toBeUndefined();
  });
});
