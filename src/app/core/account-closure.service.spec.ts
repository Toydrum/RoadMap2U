import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT, type ApiClient } from './api/api-client';
import { ApiError, type AccountClosureReceipt } from './api/contracts';
import { AuthService } from './auth/auth.service';
import {
  ACCOUNT_CLOSURE_ACTIONS,
  ACCOUNT_CLOSURE_COORDINATION,
  ACCOUNT_CLOSURE_STORAGE,
  AccountClosureService,
  accountClosureStorageKeyForOwner,
  type AccountClosureActions,
  type AccountClosureCoordination,
  type AccountClosureSnapshot,
  type AccountClosureStorage,
} from './account-closure.service';

const OWNER_A = 'user-private-a';
const OWNER_B = 'user-private-b';
const PENDING: AccountClosureReceipt = { closureId: 'closure-1', state: 'requested' };
const PURGING: AccountClosureReceipt = { closureId: 'closure-1', state: 'purging' };
const COMPLETED: AccountClosureReceipt = { closureId: 'closure-1', state: 'completed' };
const STATE_RANK = { requested: 0, purging: 1, purgeComplete: 2, completed: 3 } as const;

function snapshot(ownerId: string, receipt: AccountClosureReceipt): AccountClosureSnapshot {
  return {
    key: accountClosureStorageKeyForOwner(ownerId),
    formatVersion: 1,
    receipt,
  };
}

interface Harness {
  service: AccountClosureService;
  deleteMe: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  authUser: ReturnType<typeof signal<{ userId: string } | null>>;
  actions: AccountClosureActions;
  storage: AccountClosureStorage;
  rows: Map<string, unknown>;
  events: string[];
  notifyExternalChange(): void;
}

function harness(
  initial: readonly AccountClosureSnapshot[] = [],
  options: { userId?: string | null; activeReceiptKey?: string | null } = {},
): Harness {
  const rows = new Map(initial.map((row) => [row.key, structuredClone(row)]));
  const events: string[] = [];
  const authUser = signal<{ userId: string } | null>(
    options.userId === undefined
      ? { userId: OWNER_A }
      : options.userId
        ? { userId: options.userId }
        : null,
  );
  let activeReceiptKey = options.activeReceiptKey ?? null;
  let externalChange: (() => void) | null = null;
  const deleteMe = vi.fn(async (): Promise<AccountClosureReceipt> => {
    events.push('api');
    return PENDING;
  });
  const signOut = vi.fn(async () => {
    events.push('sign-out');
    authUser.set(null);
  });
  const storage: AccountClosureStorage = {
    read: vi.fn(async (key) => structuredClone(rows.get(key) ?? null)),
    commit: vi.fn(async (key: string, value: AccountClosureSnapshot) => {
      expect(value.key).toBe(key);
      const current = rows.get(key) as AccountClosureSnapshot | undefined;
      if (current && current.receipt.closureId !== value.receipt.closureId) {
        throw new Error('account closure receipt changed identity');
      }
      const canonical =
        current && STATE_RANK[current.receipt.state] >= STATE_RANK[value.receipt.state]
          ? current
          : value;
      events.push(`persist:${canonical.receipt.state}`);
      rows.set(key, structuredClone(canonical));
      return structuredClone(canonical);
    }),
    readActiveReceiptKey: vi.fn(async () => activeReceiptKey),
  };
  const coordination: AccountClosureCoordination = {
    subscribe: vi.fn((listener) => {
      externalChange = listener;
      return () => {
        if (externalChange === listener) externalChange = null;
      };
    }),
    publish: vi.fn(),
  };
  const actions: AccountClosureActions = {
    exportLocalCopy: vi.fn(async () => {
      events.push('export');
    }),
    clearLocalCopy: vi.fn(async (key) => {
      events.push('clear-local');
      activeReceiptKey = key;
    }),
    finalizeLocalClosure: vi.fn(async (key) => {
      events.push('finalize-local');
      rows.delete(key);
      activeReceiptKey = null;
    }),
  };

  TestBed.configureTestingModule({
    providers: [
      AccountClosureService,
      { provide: API_CLIENT, useValue: { deleteMe } as unknown as ApiClient },
      { provide: AuthService, useValue: { user: authUser.asReadonly(), signOut } },
      { provide: ACCOUNT_CLOSURE_STORAGE, useValue: storage },
      { provide: ACCOUNT_CLOSURE_ACTIONS, useValue: actions },
      { provide: ACCOUNT_CLOSURE_COORDINATION, useValue: coordination },
    ],
  });

  return {
    service: TestBed.inject(AccountClosureService),
    deleteMe,
    signOut,
    authUser,
    actions,
    storage,
    rows,
    events,
    notifyExternalChange: () => externalChange?.(),
  };
}

describe('AccountClosureService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('exports before requesting closure and persists an owner-scoped non-PII receipt', async () => {
    const h = harness();
    const key = accountClosureStorageKeyForOwner(OWNER_A);

    await expect(h.service.requestClosure()).resolves.toBe('requested');

    expect(h.events).toEqual(['export', 'api', 'persist:requested']);
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(key).toMatch(/^account\.closure:[a-z0-9-]+$/);
    expect(key).not.toContain(OWNER_A);
    expect(h.rows.get(key)).toEqual(snapshot(OWNER_A, PENDING));
    expect(JSON.stringify(h.rows.get(key))).not.toMatch(
      /user-private|username|email|displayName|userId|sub/i,
    );
  });

  it('does not call the API when the backup export fails', async () => {
    const h = harness();
    vi.mocked(h.actions.exportLocalCopy).mockRejectedValueOnce(new Error('download refused'));

    await expect(h.service.requestClosure()).resolves.toBe('error');

    expect(h.deleteMe).not.toHaveBeenCalled();
    expect(h.storage.commit).not.toHaveBeenCalled();
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('hydrates a pending receipt after reload and retries DELETE /me without exporting twice', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    h.deleteMe.mockResolvedValueOnce(COMPLETED);

    await h.service.hydrate();
    expect(h.service.receipt()).toEqual(PURGING);
    await expect(h.service.retry()).resolves.toBe('completed');

    expect(h.actions.exportLocalCopy).not.toHaveBeenCalled();
    expect(h.deleteMe).toHaveBeenCalledOnce();
  });

  it('persists completed before clearing the local copy and then identity', async () => {
    const h = harness();
    h.deleteMe.mockImplementationOnce(async () => {
      h.events.push('api');
      return COMPLETED;
    });

    await expect(h.service.requestClosure()).resolves.toBe('completed');

    expect(h.events).toEqual([
      'export',
      'api',
      'persist:completed',
      'clear-local',
      'sign-out',
      'finalize-local',
    ]);
    expect(h.rows.has(accountClosureStorageKeyForOwner(OWNER_A))).toBe(false);
  });

  it('preserves the receipt, data and session when DELETE /me fails or the JWT expires', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    h.deleteMe.mockRejectedValueOnce(new ApiError('UNAUTHENTICATED'));

    await h.service.hydrate();
    await expect(h.service.retry()).resolves.toBe('error');

    expect(h.service.receipt()).toEqual(PURGING);
    expect(h.rows.get(accountClosureStorageKeyForOwner(OWNER_A))).toEqual(
      snapshot(OWNER_A, PURGING),
    );
    expect(h.service.lastError()).toBe('UNAUTHENTICATED');
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.actions.finalizeLocalClosure).not.toHaveBeenCalled();
  });

  it('never retries owner A receipt through owner B session', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    await h.service.hydrate();

    h.authUser.set({ userId: OWNER_B });
    await expect(h.service.retry()).resolves.toBe('error');

    expect(h.deleteMe).not.toHaveBeenCalled();
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.rows.get(accountClosureStorageKeyForOwner(OWNER_A))).toEqual(
      snapshot(OWNER_A, PURGING),
    );
    expect(h.rows.has(accountClosureStorageKeyForOwner(OWNER_B))).toBe(false);
  });

  it('refreshes a newer durable receipt when a sibling tab publishes the change', async () => {
    const key = accountClosureStorageKeyForOwner(OWNER_A);
    const h = harness([snapshot(OWNER_A, PENDING)]);

    await h.service.hydrate();
    expect(h.service.receipt()).toEqual(PENDING);
    h.rows.set(key, snapshot(OWNER_A, PURGING));

    h.notifyExternalChange();

    await vi.waitFor(() => expect(h.service.receipt()).toEqual(PURGING));
  });

  it('adopts a terminal CAS winner instead of persisting a stale pending response', async () => {
    const h = harness();
    h.deleteMe.mockResolvedValueOnce(PENDING);
    vi.mocked(h.storage.commit).mockImplementationOnce(async (_key, value) => ({
      ...value,
      receipt: COMPLETED,
    }));

    await expect(h.service.requestClosure()).resolves.toBe('completed');

    expect(h.actions.clearLocalCopy).toHaveBeenCalledOnce();
    expect(h.signOut).toHaveBeenCalledOnce();
    expect(h.actions.finalizeLocalClosure).toHaveBeenCalledOnce();
  });

  it('rechecks the auth scope after asynchronous hydrate and before calling the API', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    let release!: () => void;
    vi.mocked(h.storage.read).mockImplementationOnce(
      (key) =>
        new Promise((resolve) => {
          release = () => resolve(structuredClone(h.rows.get(key)));
        }),
    );

    const retry = h.service.retry();
    await vi.waitFor(() => expect(h.storage.read).toHaveBeenCalled());
    h.authUser.set({ userId: OWNER_B });
    release();
    await expect(retry).resolves.toBe('error');

    expect(h.deleteMe).not.toHaveBeenCalled();
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it.each([
    [{ closureId: 'other-closure', state: 'purging' }, 'changed closure id'],
    [{ ...COMPLETED, extra: 'not canonical' }, 'extra receipt field'],
    [{ closureId: '', state: 'completed' }, 'malformed receipt'],
  ])('rejects a noncanonical/nonmonotonic receipt (%s: %s)', async (response, _label) => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    h.deleteMe.mockResolvedValueOnce(response as AccountClosureReceipt);

    await h.service.hydrate();
    await expect(h.service.retry()).resolves.toBe('error');

    expect(h.rows.get(accountClosureStorageKeyForOwner(OWNER_A))).toEqual(
      snapshot(OWNER_A, PURGING),
    );
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('adopts the durable state when an API response arrives out of order', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    h.deleteMe.mockResolvedValueOnce(PENDING);

    await h.service.hydrate();
    await expect(h.service.retry()).resolves.toBe('purging');

    expect(h.service.receipt()).toEqual(PURGING);
    expect(h.rows.get(accountClosureStorageKeyForOwner(OWNER_A))).toEqual(
      snapshot(OWNER_A, PURGING),
    );
    expect(h.actions.clearLocalCopy).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('keeps a completed receipt when local cleanup fails and resumes locally without API', async () => {
    const h = harness([snapshot(OWNER_A, PURGING)]);
    h.deleteMe.mockResolvedValueOnce(COMPLETED);
    vi.mocked(h.actions.clearLocalCopy).mockRejectedValueOnce(new Error('storage busy'));

    await h.service.hydrate();
    await expect(h.service.retry()).resolves.toBe('error');
    expect(h.rows.get(accountClosureStorageKeyForOwner(OWNER_A))).toEqual(
      snapshot(OWNER_A, COMPLETED),
    );
    expect(h.signOut).not.toHaveBeenCalled();

    h.events.length = 0;
    await expect(h.service.retry()).resolves.toBe('completed');
    expect(h.deleteMe).toHaveBeenCalledOnce();
    expect(h.events).toEqual([
      'persist:completed',
      'clear-local',
      'sign-out',
      'finalize-local',
    ]);
  });

  it('resumes terminal local cleanup after reload even when identity was already removed', async () => {
    const key = accountClosureStorageKeyForOwner(OWNER_A);
    const h = harness([snapshot(OWNER_A, COMPLETED)], {
      userId: null,
      activeReceiptKey: key,
    });

    await h.service.hydrate();
    expect(h.service.receipt()).toEqual(COMPLETED);
    await expect(h.service.retry()).resolves.toBe('completed');

    expect(h.deleteMe).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      'persist:completed',
      'clear-local',
      'sign-out',
      'finalize-local',
    ]);
    expect(h.rows.has(key)).toBe(false);
  });

  it('keeps the terminal receipt/fence when sign-out fails and retries locally', async () => {
    const key = accountClosureStorageKeyForOwner(OWNER_A);
    const h = harness([snapshot(OWNER_A, COMPLETED)], { activeReceiptKey: key });
    h.signOut.mockRejectedValueOnce(new Error('identity storage busy'));

    await expect(h.service.retry()).resolves.toBe('error');
    expect(h.rows.get(key)).toEqual(snapshot(OWNER_A, COMPLETED));
    expect(h.actions.finalizeLocalClosure).not.toHaveBeenCalled();

    await expect(h.service.retry()).resolves.toBe('completed');
    expect(h.deleteMe).not.toHaveBeenCalled();
  });

  it('atomically retains receipt/fence when finalization fails after sign-out', async () => {
    const key = accountClosureStorageKeyForOwner(OWNER_A);
    const h = harness([snapshot(OWNER_A, COMPLETED)], { activeReceiptKey: key });
    vi.mocked(h.actions.finalizeLocalClosure).mockRejectedValueOnce(
      new Error('final transaction busy'),
    );

    await expect(h.service.retry()).resolves.toBe('error');
    expect(h.authUser()).toBeNull();
    expect(h.rows.get(key)).toEqual(snapshot(OWNER_A, COMPLETED));

    await expect(h.service.retry()).resolves.toBe('completed');
    expect(h.deleteMe).not.toHaveBeenCalled();
    expect(h.rows.has(key)).toBe(false);
  });

  it('does not resurrect a terminal receipt from a delayed guest hydrate after finalization', async () => {
    const key = accountClosureStorageKeyForOwner(OWNER_A);
    const h = harness([snapshot(OWNER_A, COMPLETED)], { activeReceiptKey: key });
    let releaseFenceRead!: () => void;
    let guestHydrate!: Promise<void>;
    vi.mocked(h.storage.readActiveReceiptKey).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseFenceRead = () => resolve(key);
        }),
    );
    vi.mocked(h.storage.read).mockResolvedValue(snapshot(OWNER_A, COMPLETED));
    h.signOut.mockImplementationOnce(async () => {
      h.authUser.set(null);
      guestHydrate = h.service.hydrate();
    });

    await expect(h.service.retry()).resolves.toBe('completed');
    releaseFenceRead();
    await guestHydrate;

    expect(h.service.receipt()).toBeNull();
    expect(h.rows.has(key)).toBe(false);
  });

  it('coalesces a double confirmation into one export and one closure request', async () => {
    const h = harness();
    let release!: (receipt: AccountClosureReceipt) => void;
    h.deleteMe.mockImplementationOnce(
      () => new Promise<AccountClosureReceipt>((resolve) => (release = resolve)),
    );

    const first = h.service.requestClosure();
    const second = h.service.requestClosure();
    await vi.waitFor(() => expect(h.deleteMe).toHaveBeenCalledOnce());
    release(PENDING);

    await expect(Promise.all([first, second])).resolves.toEqual(['requested', 'requested']);
    expect(h.actions.exportLocalCopy).toHaveBeenCalledOnce();
  });
});
