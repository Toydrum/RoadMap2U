import type { MockStore } from './mock-cloud';

const KEY_PATH: Record<MockStore, string> = {
  users: 'userId',
  credentials: 'username',
  guardianLinks: 'linkId',
  friendships: 'friendshipId',
  friendRequests: 'requestId',
  codes: 'code',
  records: 'key',
  kv: 'key',
  households: 'householdId',
  supervisionLinks: 'linkId',
  seatAssignments: 'assignmentId',
  coverages: 'coverageId',
  minorFriendRequests: 'requestId',
  consents: 'consentId',
  subscriptionProjections: 'projectionId',
  checkoutReservations: 'reservationId',
  accountNotices: 'noticeId',
};

class MemoryRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  resolve(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.(new Event('success')));
  }
}

class MemoryOpenRequest extends MemoryRequest<IDBDatabase> {
  onupgradeneeded: ((event: Event) => void) | null = null;
  onblocked: ((event: Event) => void) | null = null;
}

class MemoryTransaction {
  error: DOMException | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  private completion: ((event: Event) => void) | null = null;
  private readonly pendingWrites: Promise<void>[] = [];

  constructor(private readonly memory: MockApiMemoryDb) {}

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.completion = handler;
    if (handler) {
      void Promise.all(this.pendingWrites).then(() =>
        queueMicrotask(() => this.completion?.(new Event('complete'))),
      );
    }
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.completion;
  }

  objectStore(name: string): IDBObjectStore {
    return new MemoryObjectStore(this.memory, name, this) as unknown as IDBObjectStore;
  }

  trackWrite(write: Promise<void>): void {
    this.pendingWrites.push(write);
  }
}

class MemoryObjectStore {
  constructor(
    private readonly memory: MockApiMemoryDb,
    private readonly name: string,
    private readonly transaction?: MemoryTransaction,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new MemoryRequest<unknown>();
    request.resolve(this.memory.store(this.name).get(String(key)));
    return request as unknown as IDBRequest;
  }

  getAll(): IDBRequest {
    const request = new MemoryRequest<unknown[]>();
    request.resolve([...this.memory.store(this.name).values()]);
    return request as unknown as IDBRequest;
  }

  put(value: unknown): IDBRequest {
    const key = (value as Record<string, unknown>)[KEY_PATH[this.name as MockStore]];
    if (typeof key !== 'string') throw new Error(`missing key for ${this.name}`);
    const request = new MemoryRequest<IDBValidKey>();
    const commit = () => {
      this.memory.store(this.name).set(key, value);
      request.resolve(key);
    };
    const held = this.memory.takeWriteHold(this.name);
    if (held) {
      const write = held.then(commit);
      this.transaction?.trackWrite(write);
    } else {
      commit();
    }
    return request as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    this.memory.store(this.name).delete(String(key));
    const request = new MemoryRequest<undefined>();
    request.resolve(undefined);
    return request as unknown as IDBRequest;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.memory.hasStore(name),
  } as DOMStringList;

  constructor(private readonly memory: MockApiMemoryDb) {}

  createObjectStore(name: string): IDBObjectStore {
    this.memory.store(name);
    return new MemoryObjectStore(this.memory, name) as unknown as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new MemoryTransaction(this.memory) as unknown as IDBTransaction;
  }

  close(): void {}
}

export class MockApiMemoryDb {
  private readonly stores = new Map<string, Map<string, unknown>>();
  private opened = false;
  private readonly writeHolds: Array<{
    store: string;
    started: () => void;
    released: Promise<void>;
    release: () => void;
  }> = [];
  private readonly database = new MemoryDatabase(this);
  readonly indexedDb = { open: () => this.open() } as unknown as IDBFactory;

  reset(): void {
    for (const hold of this.writeHolds.splice(0)) hold.release();
    this.stores.clear();
    for (const store of Object.keys(KEY_PATH)) this.store(store);
    this.seed('kv', 'seeded', { key: 'seeded', value: true });
  }

  install(): void {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: this.indexedDb,
    });
  }

  hasStore(name: string): boolean {
    return this.stores.has(name);
  }

  store(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map<string, unknown>();
      this.stores.set(name, store);
    }
    return store;
  }

  seed(store: MockStore, key: string, value: unknown): void {
    this.store(store).set(key, value);
  }

  rows<T>(store: MockStore): T[] {
    return [...this.store(store).values()] as T[];
  }

  holdNextPut(store: MockStore): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeHolds.push({ store, started: markStarted, released, release });
    return { started, release };
  }

  takeWriteHold(store: string): Promise<void> | null {
    const index = this.writeHolds.findIndex((hold) => hold.store === store);
    if (index < 0) return null;
    const [hold] = this.writeHolds.splice(index, 1);
    hold.started();
    return hold.released;
  }

  private open(): IDBOpenDBRequest {
    const request = new MemoryOpenRequest();
    queueMicrotask(() => {
      request.result = this.database as unknown as IDBDatabase;
      if (!this.opened) {
        this.opened = true;
        request.onupgradeneeded?.(new Event('upgradeneeded'));
      }
      queueMicrotask(() => request.onsuccess?.(new Event('success')));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}
