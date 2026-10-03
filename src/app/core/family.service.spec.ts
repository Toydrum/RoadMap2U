import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT, type ApiClient } from './api/api-client';
import {
  ApiError,
  FAMILY_BILLING_CONTRACT_VERSION,
  type FamilyInboxView,
  type HouseholdView,
  type MeResponse,
} from './api/contracts';
import { AuthService } from './auth/auth.service';
import { FAMILY_CACHE, FamilyService, type FamilyCachePort } from './family.service';

const ME: MeResponse = {
  profile: {
    userId: 'owner-a',
    username: 'private-user',
    displayName: 'Private Name',
    accountType: 'adult',
    socialEnabled: true,
    createdAt: 1,
  },
  family: { guardians: [], minors: [] },
};

const HOUSEHOLD: HouseholdView = {
  contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
  householdId: 'household-a',
  country: 'MX',
  state: 'active',
  myRole: 'primary_responsible',
  primaryResponsible: ME.profile,
  additionalResponsible: null,
  availableMinorSeats: 1,
  additionalResponsibleSeatAvailable: true,
  revision: 1,
  minors: [
    {
      user: { ...ME.profile, userId: 'minor-a', accountType: 'minor' },
      seat: 1,
      majorityAt: '2035-01-01',
      coverageState: 'active',
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const user = signal<{ userId: string } | null>({ userId: 'owner-a' });
  const cache = {
    read: vi.fn(async () => null),
    write: vi.fn(async (_snapshot: unknown) => undefined),
    remove: vi.fn(async () => undefined),
    removeLegacy: vi.fn(async () => undefined),
  };
  const api = {
    getMe: vi.fn(async () => ME),
    getHousehold: vi.fn(async () => HOUSEHOLD),
    getFamilyInbox: vi.fn(async (): Promise<FamilyInboxView> => ({
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      entries: [],
      nextCursor: null,
    })),
    resetChildPassword: vi.fn(async () => ({ tempPassword: 'private' })),
  };
  TestBed.configureTestingModule({
    providers: [
      FamilyService,
      { provide: API_CLIENT, useValue: api },
      { provide: AuthService, useValue: { user } },
      { provide: FAMILY_CACHE, useValue: cache },
    ],
  });
  return { service: TestBed.inject(FamilyService), user, cache, api };
}

describe('FamilyService household v2 identity boundary', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('exposes real pending requests separately from terminal notices', async () => {
    const { service, api } = setup();
    const entry = {
      noticeId: 'notice-a',
      kind: 'minor_link_request' as const,
      householdId: 'household-a',
      expectedHouseholdRevision: 1,
      state: 'pending' as const,
      createdAt: 1,
      expiresAt: 1000,
      revision: 1,
    };
    api.getFamilyInbox.mockResolvedValueOnce({
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      entries: [entry, { ...entry, noticeId: 'notice-b', state: 'accepted' }],
      nextCursor: null,
    });
    await service.refresh();
    expect(service.pendingRequests()).toEqual([entry]);
    expect(service.notices()).toEqual([{ ...entry, noticeId: 'notice-b', state: 'accepted' }]);
  });

  it('loads invitations even when the recipient has no household yet', async () => {
    const { service, api } = setup();
    api.getHousehold.mockRejectedValueOnce(new ApiError('NOT_FOUND'));
    await service.refresh();
    expect(api.getFamilyInbox).toHaveBeenCalledOnce();
    expect(service.pendingRequests()).toEqual([]);
  });

  it('reads the canonical household and persists a user-specific v2 cache', async () => {
    const { service, api, cache } = setup();
    await service.open();
    expect(api.getMe).not.toHaveBeenCalled();
    expect(api.getHousehold).toHaveBeenCalledOnce();
    expect(service.minors()).toEqual(HOUSEHOLD.minors);
    expect(cache.read).toHaveBeenCalledWith('owner-a');
    expect(cache.write).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'family.household.v2:owner-a',
        userId: 'owner-a',
        household: HOUSEHOLD,
      }),
    );
    expect(cache.removeLegacy).toHaveBeenCalledOnce();
  });

  it('hides the previous identity immediately, even before Angular effects run', async () => {
    const { service, user } = setup();
    await service.refresh();
    user.set({ userId: 'owner-b' });
    expect(service.minors()).toEqual([]);
    expect(service.loading()).toBe(false);
    expect(service.lastError()).toBeNull();
  });

  it('ignores a late response after signing out and back into the same account', async () => {
    const { service, api, user, cache } = setup();
    const late = deferred<HouseholdView>();
    api.getHousehold.mockReturnValueOnce(late.promise);
    const pending = service.refresh();
    user.set(null);
    user.set({ userId: 'owner-a' });
    late.resolve(HOUSEHOLD);
    await pending;
    expect(service.minors()).toEqual([]);
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('does not publish an error from the previous identity', async () => {
    const { service, api, user } = setup();
    const late = deferred<HouseholdView>();
    api.getHousehold.mockReturnValueOnce(late.promise);
    const pending = service.refresh();
    user.set({ userId: 'owner-b' });
    late.reject(new ApiError('FORBIDDEN'));
    await pending;
    expect(service.lastError()).toBeNull();
  });

  it('does not let an older refresh overwrite a newer household revision', async () => {
    const { service, api, cache } = setup();
    const late = deferred<HouseholdView>();
    api.getHousehold.mockReturnValueOnce(late.promise);
    const pending = service.refresh();
    api.getHousehold.mockResolvedValueOnce({ ...HOUSEHOLD, revision: 2, minors: [] });
    await service.refresh();
    late.resolve(HOUSEHOLD);
    await pending;
    expect(service.minors()).toEqual([]);
    expect(cache.write).toHaveBeenCalledOnce();
  });

  it('discards a pending password reveal after identity changes', async () => {
    const { service, api, user } = setup();
    const late = deferred<{ tempPassword: string }>();
    api.resetChildPassword.mockReturnValueOnce(late.promise);
    const pending = service.resetChildPassword('minor-a');
    user.set({ userId: 'owner-b' });
    late.resolve({ tempPassword: 'private' });
    expect(await pending).toBeNull();
  });
});

describe('FamilyService terminal cleanup', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('drains an already-started family cache write before the atomic wipe', async () => {
    let releaseWrite!: () => void;
    const cache: FamilyCachePort = {
      read: vi.fn(async () => null),
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      ),
      remove: vi.fn(async () => undefined),
      removeLegacy: vi.fn(async () => undefined),
    };
    TestBed.configureTestingModule({
      providers: [
        FamilyService,
        {
          provide: API_CLIENT,
          useValue: {
            getMe: vi.fn(async () => ME),
            getHousehold: vi.fn(async () => HOUSEHOLD),
          } as unknown as ApiClient,
        },
        { provide: AuthService, useValue: { user: signal({ userId: 'owner-a' }) } },
        { provide: FAMILY_CACHE, useValue: cache },
      ],
    });
    const service = TestBed.inject(FamilyService);

    const refresh = service.refresh();
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());
    expect(vi.mocked(cache.write).mock.calls[0]?.[0]).toMatchObject({
      key: 'family.household.v2:owner-a',
      userId: 'owner-a',
    });
    const reset = service.resetAfterAccountClosure();
    let resetFinished = false;
    void reset.then(() => (resetFinished = true));
    await Promise.resolve();

    expect(resetFinished).toBe(false);
    expect(service.household()).toBeNull();

    releaseWrite();
    await reset;
    await refresh;
    expect(service.household()).toBeNull();
  });
});
