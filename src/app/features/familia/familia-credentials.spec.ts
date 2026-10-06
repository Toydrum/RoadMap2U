import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT } from '../../core/api/api-client';
import {
  FAMILY_BILLING_CONTRACT_VERSION,
  type CreateMinorResponse,
  type HouseholdView,
} from '../../core/api/contracts';
import { AUTH_PROVIDER } from '../../core/auth/auth-provider';
import type { AuthNext, AuthUser } from '../../core/auth/auth-types';
import { AUTH_IDENTITY_PERSISTENCE, AuthService } from '../../core/auth/auth.service';
import { FAMILY_CACHE, FamilyService } from '../../core/family.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ES } from '../../core/i18n/es';
import { ToastService } from '../../shared/ui/toast.service';
import { FamiliaCard } from './familia-card';

const USER = {
  userId: 'adult-a',
  username: 'ana',
  email: null,
  displayName: 'Ana',
  accountType: 'adult' as const,
};
const HOUSEHOLD: HouseholdView = {
  contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
  householdId: 'household-a',
  country: 'MX',
  state: 'active',
  myRole: 'primary_responsible',
  primaryResponsible: USER,
  additionalResponsible: null,
  minors: [],
  availableMinorSeats: 2,
  additionalResponsibleSeatAvailable: true,
  revision: 1,
};
const CREATED: CreateMinorResponse = {
  contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
  household: HOUSEHOLD,
  minor: {
    userId: 'minor-a',
    username: 'luna',
    displayName: 'Luna',
    accountType: 'minor',
    socialEnabled: false,
    createdAt: 1,
  },
  tempPassword: 'private-test-password',
};

async function setup(validationUser: AuthUser = USER) {
  let completeCreate!: (result: CreateMinorResponse) => void;
  const api = {
    getHousehold: vi.fn(async () => HOUSEHOLD),
    getFamilyInbox: vi.fn(async () => ({
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      entries: [],
      nextCursor: null,
    })),
    createMinor: vi.fn(
      () =>
        new Promise<CreateMinorResponse>((resolve) => {
          completeCreate = resolve;
        }),
    ),
  };
  const provider = {
    // Cognito and IndexedDB return distinct objects for an unchanged account.
    currentSession: vi.fn(async () => ({ user: { ...validationUser }, issuedAt: Date.now() })),
    signIn: vi.fn(async (): Promise<AuthNext> => ({
      kind: 'done',
      session: { user: { ...USER }, issuedAt: Date.now() },
    })),
    signOut: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    imports: [FamiliaCard],
    providers: [
      AuthService,
      FamilyService,
      { provide: API_CLIENT, useValue: api },
      { provide: AUTH_PROVIDER, useValue: provider },
      {
        provide: AUTH_IDENTITY_PERSISTENCE,
        useValue: {
          read: async () => ({ key: 'auth.identity', user: { ...USER }, cachedAt: 1 }),
          write: async () => undefined,
          clear: async () => undefined,
        },
      },
      {
        provide: FAMILY_CACHE,
        useValue: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined,
          removeLegacy: async () => undefined,
        },
      },
      {
        provide: I18nService,
        useValue: {
          t: signal(ES),
          lang: signal('es'),
          fill: (text: string, vars: Record<string, unknown>) =>
            text.replace(/\{(\w+)\}/g, (_, key) => String(vars[key])),
        },
      },
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: Router, useValue: { navigate: vi.fn() } },
    ],
  });
  const auth = TestBed.inject(AuthService);
  await auth.hydrate();
  await TestBed.inject(FamilyService).open();
  const fixture = TestBed.createComponent(FamiliaCard);
  fixture.detectChanges();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const click = (selector: string) => {
    const button = root.querySelector<HTMLButtonElement>(selector)!;
    expect(button, selector).not.toBeNull();
    expect(button.disabled, selector).toBe(false);
    button.click();
    fixture.detectChanges();
  };
  const input = (selector: string, value: string) => {
    const field = root.querySelector<HTMLInputElement>(selector)!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const create = () => {
    click('.fam-create');
    input('.fam-username', 'luna');
    input('.fam-majority-date', '2035-01-01');
    click('.fam-declaration');
    click('.fam-consent');
    click('.fam-create-submit');
  };
  const settle = async () => {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  await settle();
  expect(TestBed.inject(FamilyService).loading()).toBe(false);
  return {
    root,
    fixture,
    auth,
    provider,
    create,
    settle,
    resolveCreate: () => completeCreate(CREATED),
  };
}

describe('Family credentials during background session validation', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the temporary password visible when an unchanged session is validated', async () => {
    const { root, provider, create, resolveCreate, settle } = await setup();
    create();
    resolveCreate();
    await settle();
    expect(root.querySelector('.temp-password')?.textContent).toBe(CREATED.tempPassword);

    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(provider.currentSession).toHaveBeenCalledOnce();
    expect(root.querySelector('.temp-password')?.textContent).toBe(CREATED.tempPassword);
  });

  it('shows a successful creation that finishes after unchanged session validation', async () => {
    const { root, create, resolveCreate, settle } = await setup();
    create();
    await vi.advanceTimersByTimeAsync(4_000);
    resolveCreate();
    await settle();
    expect(root.querySelector('.temp-password')?.textContent).toBe(CREATED.tempPassword);
  });

  it('discards creation credentials after an explicit dismissal', async () => {
    const { root, create, resolveCreate, settle } = await setup();
    create();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    resolveCreate();
    await settle();
    expect(root.querySelector('.familia-sheet')).toBeNull();
    expect(root.textContent).not.toContain(CREATED.tempPassword);
  });

  it('discards creation credentials after sign-out', async () => {
    const { root, auth, create, resolveCreate, settle } = await setup();
    create();
    await auth.signOut();
    resolveCreate();
    await settle();
    expect(root.querySelector('.familia-sheet')).toBeNull();
    expect(root.textContent).not.toContain(CREATED.tempPassword);
  });

  it('discards creation credentials after a new login to the same account', async () => {
    const { root, auth, create, resolveCreate, settle } = await setup();
    create();
    await auth.signIn(USER.username, 'new-session-password');
    resolveCreate();
    await settle();
    expect(root.querySelector('.familia-sheet')).toBeNull();
    expect(root.textContent).not.toContain(CREATED.tempPassword);
  });

  it.each([
    { ...USER, userId: 'different-adult' },
    { ...USER, accountType: 'minor' as const },
  ])('hides credentials when validation changes the account or role: %j', async (changedUser) => {
    const { root, create, resolveCreate, settle } = await setup(changedUser);
    create();
    resolveCreate();
    await settle();
    expect(root.querySelector('.temp-password')?.textContent).toBe(CREATED.tempPassword);
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(root.querySelector('.familia-sheet')).toBeNull();
    expect(root.textContent).not.toContain(CREATED.tempPassword);
  });
});
