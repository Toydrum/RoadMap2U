import { describe, expect, it } from 'vitest';
import { migrateSchemaIfNeeded, replaceAllInDatabase } from './idb';

type Row = Record<string, unknown>;
type Tables = Record<string, Map<string, Row>>;

class MemoryRequest<T> {
  readyState: IDBRequestReadyState = 'pending';
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;

  constructor(value: T, tx: MemoryTransaction) {
    tx.read(() => {
      this.result = value;
      this.readyState = 'done';
      this.onsuccess?.call(this as unknown as IDBRequest<T>, new Event('success'));
    });
  }
}

class MemoryTransaction {
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  error: DOMException | null = null;

  private readonly draft: Tables;
  private pendingReads = 0;
  private finishQueued = false;
  private aborted = false;

  constructor(
    private readonly source: Tables,
    private readonly failPutId: string | null,
  ) {
    this.draft = Object.fromEntries(
      Object.entries(source).map(([name, rows]) => [
        name,
        new Map([...rows].map(([key, row]) => [key, structuredClone(row)])),
      ]),
    );
  }

  read(deliver: () => void): void {
    this.pendingReads += 1;
    queueMicrotask(() => {
      if (this.aborted) return;
      deliver();
      this.pendingReads -= 1;
      this.queueFinish();
    });
  }

  objectStore(name: string): IDBObjectStore {
    const rows = this.draft[name];
    if (!rows) throw new Error(`missing fake store ${name}`);
    return {
      getAll: () =>
        new MemoryRequest(
          [...rows.values()].map((row) => structuredClone(row)),
          this,
        ),
      get: (key: IDBValidKey) =>
        new MemoryRequest(
          rows.has(String(key)) ? structuredClone(rows.get(String(key))) : undefined,
          this,
        ),
      clear: () => {
        rows.clear();
        this.queueFinish();
        return {} as IDBRequest<undefined>;
      },
      put: (value: Row) => {
        if (value['id'] === this.failPutId) throw new Error('synthetic put failure');
        const key = name === 'meta' ? value['key'] : value['id'];
        rows.set(String(key), structuredClone(value));
        this.queueFinish();
        return {} as IDBRequest<IDBValidKey>;
      },
    } as unknown as IDBObjectStore;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    queueMicrotask(() => {
      this.onabort?.call(this as unknown as IDBTransaction, new Event('abort'));
    });
  }

  private queueFinish(): void {
    if (this.finishQueued) return;
    this.finishQueued = true;
    queueMicrotask(() => {
      this.finishQueued = false;
      if (this.aborted || this.pendingReads > 0) return;
      for (const [name, rows] of Object.entries(this.draft)) {
        this.source[name] = new Map([...rows].map(([key, row]) => [key, structuredClone(row)]));
      }
      this.oncomplete?.call(this as unknown as IDBTransaction, new Event('complete'));
    });
  }
}

class MemoryDatabase {
  lastTransaction: MemoryTransaction | null = null;

  constructor(
    readonly tables: Tables,
    private readonly failPutId: string | null = null,
  ) {}

  transaction(): IDBTransaction {
    this.lastTransaction = new MemoryTransaction(this.tables, this.failPutId);
    return this.lastTransaction as unknown as IDBTransaction;
  }
}

const rowMap = (rows: Row[], key: 'id' | 'key' = 'id') =>
  new Map(rows.map((row) => [String(row[key]), structuredClone(row)]));

describe('live IndexedDB schema migration atomicity', () => {
  it('commits heartId and schema marker together without rewriting nodes', async () => {
    const tree = {
      id: 'tree-a',
      createdAt: 1,
      updatedAt: 1,
      rev: 1,
      deletedAt: null,
      name: 'A',
      accent: 'moss',
      order: 10,
      currentNodeId: 'keep',
      archivedAt: null,
    };
    const root = {
      id: 'root-a',
      createdAt: 1,
      updatedAt: 1,
      rev: 1,
      deletedAt: null,
      treeId: 'tree-a',
      parentId: null,
      archivedAt: null,
      order: 10,
    };
    const db = new MemoryDatabase({
      trees: rowMap([tree]),
      nodes: rowMap([root]),
      meta: rowMap([{ key: 'schema.version', version: 12 }], 'key'),
    });
    const nodesBefore = JSON.stringify([...db.tables['nodes'].values()]);

    await migrateSchemaIfNeeded(db as unknown as IDBDatabase);

    expect(db.tables['trees'].get('tree-a')?.['heartId']).toBe('root-a');
    expect(db.tables['trees'].get('tree-a')?.['currentNodeId']).toBe('keep');
    expect(db.tables['meta'].get('schema.version')?.['version']).toBe(13);
    expect(JSON.stringify([...db.tables['nodes'].values()])).toBe(nodesBefore);
  });

  it('aborts every write when the stored schema version is future', async () => {
    const db = new MemoryDatabase({
      trees: rowMap([{ id: 'tree-a', currentNodeId: 'keep' }]),
      nodes: rowMap([
        { id: 'root-a', treeId: 'tree-a', parentId: null, deletedAt: null, archivedAt: null },
      ]),
      meta: rowMap([{ key: 'schema.version', version: 14 }], 'key'),
    });
    const before = JSON.stringify(db.tables, (_key, value) =>
      value instanceof Map ? [...value] : value,
    );

    await expect(migrateSchemaIfNeeded(db as unknown as IDBDatabase)).rejects.toThrow(/newer/i);

    expect(
      JSON.stringify(db.tables, (_key, value) => (value instanceof Map ? [...value] : value)),
    ).toBe(before);
  });
});

describe('backup replace atomicity', () => {
  it('aborts the whole cross-store replacement on a synchronous put failure', async () => {
    const db = new MemoryDatabase(
      {
        trees: rowMap([{ id: 'old-tree' }]),
        nodes: rowMap([{ id: 'old-node' }]),
        meta: rowMap([], 'key'),
      },
      'fail-put',
    );

    await expect(
      replaceAllInDatabase(db as unknown as IDBDatabase, [
        { store: 'trees', rows: [{ id: 'new-tree' }] },
        { store: 'nodes', rows: [{ id: 'fail-put' }] },
      ]),
    ).rejects.toThrow(/synthetic put failure/i);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect([...db.tables['trees'].keys()]).toEqual(['old-tree']);
    expect([...db.tables['nodes'].keys()]).toEqual(['old-node']);
    expect(db.lastTransaction).not.toBeNull();
  });
});
