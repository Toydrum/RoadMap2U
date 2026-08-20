import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../auth/auth-provider';
import { Tree } from '../db/schema';
import { EN } from '../i18n/en';
import { ES } from '../i18n/es';
import {
  API_PATHS,
  AccessSummary,
  AccountClosureReceipt,
  ApiError,
  ApiErrorCode,
  CONTRACT_VERSION,
  LIMITS,
  PlanCatalog,
  PREPAYMENT_PLAN_CATALOG,
  SERVER_API_ERROR_CODES,
  SyncPushRequest,
  SyncPushV2Request,
  isRetryableApiErrorCode,
} from './contracts';
import { HttpApi } from './http-api';
import { MockRecordRow, MockStore } from './mock-cloud';
import { MockApi } from './mock-api';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const EXPECTED_CATALOG = {
  version: '2026-08-prepayment-v1',
  pricingVersion: 'launch-2026',
  currency: 'MXN',
  taxInclusive: true,
  paymentsEnabled: false,
  plans: {
    free: {
      limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
      capabilities: { cloudSync: false, social: false, family: false },
    },
    premium: {
      limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
      capabilities: { cloudSync: true, social: true, family: false },
      prices: {
        month: { amountMinor: 9900 },
        year: { amountMinor: 94900 },
      },
    },
  },
} as const satisfies PlanCatalog;

const EXPECTED_FREE_ACCESS: AccessSummary = {
  effectivePlanKey: 'free',
  catalogVersion: '2026-08-prepayment-v1',
  status: 'active',
  activeSources: [{ kind: 'default', sourceId: 'default', planKey: 'free', validUntil: null }],
  limits: { maxActiveTrees: 2, maxVisibleBranchesPerTree: 10 },
  capabilities: { cloudSync: false, social: false, family: false },
  usage: { activeTrees: 0, visibleBranchesByTree: {} },
  revision: 0,
  nextRecomputeAt: null,
  offlineValidUntil: NOW + DAY_MS,
};

const COMMERCIAL_CODES = [
  'QUOTA_EXCEEDED',
  'CAPABILITY_REQUIRED',
  'MUTATION_GROUP_INVALID',
  'ACCESS_REVISION_CONFLICT',
  'ACCESS_CODE_INVALID',
  'ACCESS_CODE_RATE_LIMITED',
  'ACCESS_CODE_ALREADY_REDEEMED',
  'SYNC_SCHEMA_INVALID',
  'SYNC_CLIENT_UPGRADE_REQUIRED',
  'USAGE_MIGRATION_IN_PROGRESS',
  'COMMERCIAL_CONFIGURATION_UNAVAILABLE',
] as const satisfies readonly ApiErrorCode[];

const ALL_API_ERROR_CODES = [
  ...SERVER_API_ERROR_CODES,
  'offline',
  'server',
  'unknown',
] as const satisfies readonly ApiErrorCode[];

const SYNC_RECORD = {
  store: 'trees',
  record: {
    id: 'tree-1',
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
  } as Tree,
} as const;

const MOCK_KEY_PATH: Record<MockStore, string> = {
  users: 'userId',
  credentials: 'username',
  guardianLinks: 'linkId',
  friendships: 'friendshipId',
  friendRequests: 'requestId',
  codes: 'code',
  records: 'key',
  kv: 'key',
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

  constructor(private readonly cloud: MemoryMockCloud) {}

  set oncomplete(handler: ((event: Event) => void) | null) {
    this.completion = handler;
    if (handler) queueMicrotask(() => this.completion?.(new Event('complete')));
  }

  get oncomplete(): ((event: Event) => void) | null {
    return this.completion;
  }

  objectStore(name: string): IDBObjectStore {
    return new MemoryObjectStore(this.cloud, name) as unknown as IDBObjectStore;
  }
}

class MemoryObjectStore {
  constructor(
    private readonly cloud: MemoryMockCloud,
    private readonly name: string,
  ) {}

  get(key: IDBValidKey): IDBRequest {
    const request = new MemoryRequest<unknown>();
    request.resolve(this.cloud.store(this.name).get(String(key)));
    return request as unknown as IDBRequest;
  }

  getAll(): IDBRequest {
    const request = new MemoryRequest<unknown[]>();
    request.resolve([...this.cloud.store(this.name).values()]);
    return request as unknown as IDBRequest;
  }

  put(value: unknown): IDBRequest {
    const path = MOCK_KEY_PATH[this.name as MockStore];
    const key = (value as Record<string, unknown>)[path];
    if (typeof key !== 'string') throw new Error(`missing key for ${this.name}`);
    this.cloud.store(this.name).set(key, value);
    const request = new MemoryRequest<IDBValidKey>();
    request.resolve(key);
    return request as unknown as IDBRequest;
  }

  delete(key: IDBValidKey): IDBRequest {
    this.cloud.store(this.name).delete(String(key));
    const request = new MemoryRequest<undefined>();
    request.resolve(undefined);
    return request as unknown as IDBRequest;
  }
}

class MemoryDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.cloud.hasStore(name),
  } as DOMStringList;

  constructor(private readonly cloud: MemoryMockCloud) {}

  createObjectStore(name: string): IDBObjectStore {
    this.cloud.store(name);
    return new MemoryObjectStore(this.cloud, name) as unknown as IDBObjectStore;
  }

  transaction(): IDBTransaction {
    return new MemoryTransaction(this.cloud) as unknown as IDBTransaction;
  }

  close(): void {}
}

class MemoryMockCloud {
  private readonly stores = new Map<string, Map<string, unknown>>();
  private opened = false;
  private readonly database = new MemoryDatabase(this);
  readonly open = vi.fn(() => this.openDatabase());
  readonly indexedDb = { open: this.open } as unknown as IDBFactory;

  reset(): void {
    this.stores.clear();
    for (const store of Object.keys(MOCK_KEY_PATH)) this.store(store);
    this.seed('kv', 'seeded', { key: 'seeded', value: 1 });
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

  private openDatabase(): IDBOpenDBRequest {
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

const mockCloud = new MemoryMockCloud();

function seedCaller(userId: string): void {
  mockCloud.seed('users', userId, {
    userId,
    username: userId,
    displayName: 'Rocío',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: NOW,
    email: 'rocio@example.com',
  });
}

function mockToken(sub: string): string {
  return `mock.${btoa(JSON.stringify({ sub, username: sub }))}.token`;
}

function authFor(userId: string): AuthProvider & { deleteAccount: ReturnType<typeof vi.fn> } {
  return {
    idToken: vi.fn(async () => mockToken(userId)),
    deleteAccount: vi.fn(async () => undefined),
  } as unknown as AuthProvider & { deleteAccount: ReturnType<typeof vi.fn> };
}

describe('commercial access contract fixtures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockCloud.reset();
    seedCaller('rocio');
    vi.stubGlobal('indexedDB', mockCloud.indexedDb);
  });

  it('publishes the exact prepayment catalog without opening auth or mock cloud', async () => {
    const auth = {
      idToken: vi.fn(async () => {
        throw new Error('the public catalog must not request a token');
      }),
    } as unknown as AuthProvider;
    const opensBefore = mockCloud.open.mock.calls.length;

    const catalog = await new MockApi(auth).getPlans();

    expect(catalog).toEqual(EXPECTED_CATALOG);
    expect(PREPAYMENT_PLAN_CATALOG).toEqual(EXPECTED_CATALOG);
    expect(auth.idToken).not.toHaveBeenCalled();
    expect(mockCloud.open).toHaveBeenCalledTimes(opensBefore);
  });

  it('returns a deterministic Free fallback for the authenticated mock caller', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);

    const access = await new MockApi(authFor('rocio')).getAccess();

    expect(access).toEqual(EXPECTED_FREE_ACCESS);
  });

  it('never turns an arbitrary key into Premium in the on-device mock', async () => {
    await expect(
      new MockApi(authFor('rocio')).redeemAccessCode('RM2U1.fake.secret'),
    ).rejects.toMatchObject({ code: 'ACCESS_CODE_INVALID' });
  });

  it('routes mock account deletion through the API seam and returns a closure receipt', async () => {
    const auth = authFor('rocio');

    const receipt = await new MockApi(auth).deleteMe();

    expect(receipt).toEqual({ closureId: 'mock:rocio', state: 'completed' });
    expect(auth.deleteAccount).toHaveBeenCalledOnce();
  });

  it('keeps the v12 push shape while adding contract v2 mutation groups', () => {
    const legacy: SyncPushRequest = { schemaVersion: 12, records: [SYNC_RECORD] };
    const grouped: SyncPushV2Request = {
      schemaVersion: 13,
      contractVersion: CONTRACT_VERSION,
      mutationGroups: [{ id: 'mutation-1', expectedCount: 1, records: [SYNC_RECORD] }],
    };

    expect(legacy.records).toEqual([SYNC_RECORD]);
    expect(CONTRACT_VERSION).toBe(2);
    expect(grouped.contractVersion).toBe(2);
    expect(grouped.mutationGroups[0]).toEqual({
      id: 'mutation-1',
      expectedCount: 1,
      records: [SYNC_RECORD],
    });
    expect(LIMITS.syncPushMax).toBe(100);
    expect(LIMITS.syncMutationGroupMax).toBe(20);
  });

  it.each([
    { id: 'fractional', expectedCount: 1.5, records: [SYNC_RECORD] },
    { id: 'mismatch', expectedCount: 2, records: [SYNC_RECORD] },
    { id: 'empty', expectedCount: 0, records: [] },
    { id: 'too-large', expectedCount: 21, records: Array(21).fill(SYNC_RECORD) },
  ])('rejects an unsafe or incomplete mutation group: $id', async (group) => {
    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [group],
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_GROUP_INVALID' });
  });

  it('prevalidates every record in a v2 group before writing any member', async () => {
    const malformed = {
      store: 'trees',
      record: { id: 'tree-malformed', rev: 'not-a-number', updatedAt: NOW },
    } as unknown as typeof SYNC_RECORD;

    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [
          {
            id: 'semantic-invalid',
            expectedCount: 2,
            records: [SYNC_RECORD, malformed],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'SYNC_SCHEMA_INVALID' });

    expect(mockCloud.rows('records')).toEqual([]);
  });

  it('rejects a stale v2 group atomically and returns the stored winner', async () => {
    const storedRecord = {
      ...SYNC_RECORD.record,
      id: 'tree-stale',
      rev: 2,
      updatedAt: NOW + 2,
    } as Tree;
    const storedRow = {
      key: 'rocio|trees|tree-stale',
      ownerId: 'rocio',
      store: 'trees',
      record: storedRecord,
      seq: 7,
      syncedAt: NOW,
    } satisfies MockRecordRow;
    mockCloud.seed('records', storedRow.key, storedRow);
    mockCloud.seed('kv', 'changeSeq', { key: 'changeSeq', value: 7 });

    const validNew = {
      ...SYNC_RECORD,
      record: { ...SYNC_RECORD.record, id: 'tree-new' } as Tree,
    };
    const stale = {
      ...SYNC_RECORD,
      record: { ...SYNC_RECORD.record, id: 'tree-stale' } as Tree,
    };

    await expect(
      new MockApi(authFor('rocio')).pushSync({
        schemaVersion: 12,
        contractVersion: CONTRACT_VERSION,
        mutationGroups: [{ id: 'stale-group', expectedCount: 2, records: [validNew, stale] }],
      }),
    ).resolves.toEqual({
      applied: [],
      rejected: [{ id: 'tree-stale', reason: 'STALE_REV' }],
      serverRecords: [{ store: 'trees', record: storedRecord }],
    });

    expect(mockCloud.rows<MockRecordRow>('records')).toEqual([storedRow]);
  });

  it('recognizes every commercial error without adding retryability to the wire envelope', () => {
    expect(COMMERCIAL_CODES.every((code) => SERVER_API_ERROR_CODES.includes(code))).toBe(true);
    expect(isRetryableApiErrorCode('USAGE_MIGRATION_IN_PROGRESS')).toBe(true);
    expect(isRetryableApiErrorCode('ACCESS_REVISION_CONFLICT')).toBe(true);
    expect(isRetryableApiErrorCode('QUOTA_EXCEEDED')).toBe(false);
    const migrationError = new ApiError('USAGE_MIGRATION_IN_PROGRESS');
    expect(migrationError.retryable).toBe(true);
    expect(Object.hasOwn(migrationError, 'retryable')).toBe(false);
    expect(JSON.stringify(migrationError)).not.toContain('retryable');
  });

  it('has safe bilingual UX copy for every widened ApiErrorCode', () => {
    for (const code of ALL_API_ERROR_CODES) {
      expect(ES.familia.errors[code], `missing ES copy for ${code}`).toEqual(expect.any(String));
      expect(EN.familia.errors[code], `missing EN copy for ${code}`).toEqual(expect.any(String));
    }
  });
});

describe('HttpApi commercial transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('fetches the public catalog without asking AuthProvider for an idToken', async () => {
    const auth = {
      idToken: vi.fn(async () => {
        throw new Error('the public catalog must not request a token');
      }),
    } as unknown as AuthProvider;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(EXPECTED_CATALOG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HttpApi(auth).getPlans()).resolves.toEqual(EXPECTED_CATALOG);

    expect(auth.idToken).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/v1' + API_PATHS.plans, {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('uses the authenticated exact access, redemption, and deletion routes', async () => {
    const auth = authFor('rocio');
    const receipt: AccountClosureReceipt = { closureId: 'closure-1', state: 'requested' };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.method === 'DELETE' ? receipt : EXPECTED_FREE_ACCESS;
      expect((init?.headers as Record<string, string>)['authorization']).toBe(
        `Bearer ${mockToken('rocio')}`,
      );
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = new HttpApi(auth);

    await expect(api.getAccess()).resolves.toEqual(EXPECTED_FREE_ACCESS);
    await expect(api.redeemAccessCode('RM2U1.issue.secret')).resolves.toEqual(EXPECTED_FREE_ACCESS);
    await expect(api.deleteMe()).resolves.toEqual(receipt);

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['/v1' + API_PATHS.access, 'GET'],
      ['/v1' + API_PATHS.accessCodesRedeem, 'POST'],
      ['/v1' + API_PATHS.me, 'DELETE'],
    ]);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify({ code: 'RM2U1.issue.secret' }));
  });
});
