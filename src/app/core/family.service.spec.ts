import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT, type ApiClient } from './api/api-client';
import { type MeResponse } from './api/contracts';
import { AuthService } from './auth/auth.service';
import {
  FAMILY_CACHE,
  FamilyService,
  type FamilyCachePort,
  type FamilyMeSnapshot,
} from './family.service';

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
    };
    TestBed.configureTestingModule({
      providers: [
        FamilyService,
        { provide: API_CLIENT, useValue: { getMe: vi.fn(async () => ME) } as unknown as ApiClient },
        { provide: AuthService, useValue: { user: signal({ userId: 'owner-a' }) } },
        { provide: FAMILY_CACHE, useValue: cache },
      ],
    });
    const service = TestBed.inject(FamilyService);

    const refresh = service.refresh();
    await vi.waitFor(() => expect(cache.write).toHaveBeenCalledOnce());
    expect(vi.mocked(cache.write).mock.calls[0]?.[0]).toMatchObject({
      key: 'family.me',
      userId: 'owner-a',
    } satisfies Partial<FamilyMeSnapshot>);
    const reset = service.resetAfterAccountClosure();
    let resetFinished = false;
    void reset.then(() => (resetFinished = true));
    await Promise.resolve();

    expect(resetFinished).toBe(false);
    expect(service.me()).toBeNull();

    releaseWrite();
    await reset;
    await refresh;
    expect(service.me()).toBeNull();
  });
});
