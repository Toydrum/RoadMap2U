import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/auth/auth.service';
import {
  FAMILY_BILLING_CONTRACT_VERSION,
  type CreateMinorResponse,
  type FamilyInboxEntry,
  type FamilyInboxView,
  type HouseholdView,
} from '../../core/api/contracts';
import { FamilyService } from '../../core/family.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ES } from '../../core/i18n/es';
import { ToastService } from '../../shared/ui/toast.service';
import { FamiliaCard } from './familia-card';

const adult = {
  userId: 'adult-a',
  username: 'ana',
  displayName: 'Ana',
  accountType: 'adult' as const,
};
const minor = {
  userId: 'minor-a',
  username: 'luna',
  displayName: 'Luna',
  accountType: 'minor' as const,
  socialEnabled: true,
};
const base: HouseholdView = {
  contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
  householdId: 'household-a',
  country: 'MX',
  state: 'active',
  myRole: 'primary_responsible',
  primaryResponsible: adult,
  additionalResponsible: {
    user: { ...adult, userId: 'adult-b', displayName: 'Bea' },
    minorIds: [minor.userId],
    coverageState: 'active',
  },
  minors: [{ user: minor, majorityAt: '2035-01-01', seat: 1, coverageState: 'active' }],
  availableMinorSeats: 1,
  additionalResponsibleSeatAvailable: false,
  revision: 3,
};

function setup(household: HouseholdView = base) {
  const user = signal<{ userId: string; accountType: 'adult' | 'minor' } | null>(
    household.myRole === null
      ? minor
      : household.myRole === 'additional_responsible'
        ? { ...adult, userId: 'adult-b' }
        : adult,
  );
  const view = signal<HouseholdView | null>(household);
  const fam = {
    household: view,
    myRole: computed(() => view()?.myRole ?? null),
    minors: computed(() => view()?.minors ?? []),
    additionalResponsible: computed(() => view()?.additionalResponsible ?? null),
    fresh: signal(true),
    loading: signal(false),
    lastError: signal(null),
    notices: signal([]),
    pendingRequests: signal<FamilyInboxEntry[] | null>(null),
    statusNotices: signal([]),
    inbox: signal<FamilyInboxView | null>(null),
    inboxLoading: signal(false),
    inboxError: signal(null),
    open: vi.fn(async () => undefined),
    clear: vi.fn(),
    createMinor: vi.fn(async (): Promise<CreateMinorResponse | null> => null),
    resetChildPassword: vi.fn(async (): Promise<{ tempPassword: string } | null> => null),
    transferPrimaryResponsibility: vi.fn(async () => true),
    requestMinorLink: vi.fn(async () => ({ requestId: 'link-a' })),
    inviteAdditional: vi.fn(async () => ({ invitationId: 'invite-a' })),
    acceptAdditional: vi.fn(async () => true),
    approveMinorLink: vi.fn(async () => true),
    acceptMinorLink: vi.fn(async () => true),
  };
  TestBed.configureTestingModule({
    imports: [FamiliaCard],
    providers: [
      { provide: FamilyService, useValue: fam },
      {
        provide: AuthService,
        useValue: { user, status: computed(() => (user() ? 'signedIn' : 'guest')) },
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
  const fixture = TestBed.createComponent(FamiliaCard);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const click = (selector: string) => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    expect(button, selector).not.toBeNull();
    button!.click();
    fixture.detectChanges();
  };
  return { fixture, root, fam, user, click };
}

describe('FamiliaCard household v2', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('names the payer, additional responsible, seats and exact supervision scope', () => {
    const { root } = setup();
    expect(root.textContent).toContain('Responsable principal de la cuenta');
    expect(root.textContent).toContain('Responsable adicional autorizado');
    expect(root.querySelector('.fam-scope')?.textContent).toContain('Luna');
    expect(root.querySelector('.fam-seats')?.textContent).toContain('1');
  });

  it('does not offer a third minor account', () => {
    const { root } = setup({ ...base, availableMinorSeats: 0 });
    expect(root.querySelector<HTMLButtonElement>('.fam-create')?.disabled).toBe(true);
  });

  it('does not offer new family capacity to an adult without coverage', () => {
    const { root } = setup({ ...base, familyCoverage: null,
      additionalResponsible: null, additionalResponsibleSeatAvailable: true });
    expect(root.querySelector<HTMLButtonElement>('.fam-create')?.disabled).toBe(true);
    expect(root.querySelector('.fam-link-request')).toBeNull();
    expect(root.querySelector('.fam-additional-invite')).toBeNull();
  });

  it('sends a minor link request with the live household revision and typed code', async () => {
    const { root, click, fam, fixture } = setup();
    click('.fam-link-request');
    const input = root.querySelector<HTMLInputElement>('.fam-link-code-input')!;
    input.value = 'CODE1234';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    click('.fam-link-submit');
    await fixture.whenStable();
    expect(fam.requestMinorLink).toHaveBeenCalledWith(expect.objectContaining({
      householdId: base.householdId, expectedHouseholdRevision: base.revision,
      code: 'CODE1234', policyVersion: 'family-policy-v2',
    }));
  });

  it('requires a named adult and minor scope for an additional invitation', async () => {
    const { root, click, fam, fixture } = setup({ ...base,
      additionalResponsible: null, additionalResponsibleSeatAvailable: true });
    click('.fam-additional-invite');
    const input = root.querySelector<HTMLInputElement>('.fam-adult-id-input')!;
    input.value = 'adult-b';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    click('.fam-additional-submit');
    await fixture.whenStable();
    expect(fam.inviteAdditional).toHaveBeenCalledWith(expect.objectContaining({
      intendedAdultId: 'adult-b', minorIds: [minor.userId],
      expectedHouseholdRevision: base.revision,
    }));
  });

  it('only proposes a transfer after explicit primary confirmation', async () => {
    const { root, click, fam, fixture } = setup();
    click('.fam-transfer');
    expect(fam.transferPrimaryResponsibility).not.toHaveBeenCalled();
    expect(root.textContent).toContain('aceptar');
    click('.fam-transfer-confirm');
    await fixture.whenStable();
    expect(fam.transferPrimaryResponsibility).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId: 'household-a',
        expectedHouseholdRevision: 3,
        policyVersion: 'family-policy-v2',
        newPrimaryAccountId: 'adult-b',
      }),
    );
  });

  it('shows recovery, export and deletion only for the primary responsible', () => {
    const { root, click } = setup();
    click('.fam-open');
    expect(root.querySelector('.fam-reset')).not.toBeNull();
    expect(root.querySelector('.fam-export')).not.toBeNull();
    expect(root.querySelector('.fam-delete')).not.toBeNull();
  });

  it('accepts only a current private transfer proposal and reuses its command ID', async () => {
    const { root, click, fam, fixture } = setup({ ...base, myRole: 'additional_responsible' });
    const entry: FamilyInboxEntry = {
      noticeId: '9c09f76b-246a-4f0d-a188-8ba97f7f518d',
      kind: 'primary_transfer',
      householdId: base.householdId,
      expectedHouseholdRevision: base.revision,
      state: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revision: 1,
    };
    fam.inbox.set({
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      entries: [entry],
      nextCursor: null,
    });
    fam.pendingRequests.set([entry]);
    fixture.detectChanges();
    click('.fam-transfer-accept');
    expect(fam.transferPrimaryResponsibility).not.toHaveBeenCalled();
    click('.fam-transfer-confirm');
    await fixture.whenStable();
    expect(fam.transferPrimaryResponsibility).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: entry.noticeId,
        newPrimaryAccountId: 'adult-b',
        expectedHouseholdRevision: 3,
      }),
    );
    fam.inbox.set({
      contractVersion: FAMILY_BILLING_CONTRACT_VERSION,
      entries: [{ ...entry, expiresAt: Date.now() - 1 }],
      nextCursor: null,
    });
    fixture.detectChanges();
    expect(root.querySelector('.fam-transfer-accept')).toBeNull();
  });

  it('limits the additional responsible to their assigned minor without identity tools', () => {
    const { root, click } = setup({ ...base, myRole: 'additional_responsible' });
    click('.fam-open');
    expect(root.querySelector('.enter-forest')).not.toBeNull();
    for (const selector of [
      '.fam-reset',
      '.fam-export',
      '.fam-delete',
      '.fam-transfer',
      '.fam-rename',
      '.fam-social',
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
    expect(root.querySelector('.fam-create')).toBeNull();
  });

  it('does not open management for a minor outside additional scope or for a minor login', () => {
    const { root } = setup({
      ...base,
      myRole: 'additional_responsible',
      additionalResponsible: { ...base.additionalResponsible!, minorIds: ['different-minor'] },
    });
    expect(root.querySelector('.fam-open')).toBeNull();
  });

  it('shows a transparent minor view without administration actions', () => {
    const { root } = setup({ ...base, myRole: null });
    expect(root.textContent).toContain('Ana');
    expect(root.querySelector('.fam-create')).toBeNull();
    expect(root.querySelector('.fam-open')).toBeNull();
  });

  it('requires a declared majority date and both versioned consents before createMinor', async () => {
    const { root, fam, click, fixture } = setup();
    click('.fam-create');
    const set = (selector: string, value: string) => {
      const input = root.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    set('.fam-username', 'luna');
    expect(root.querySelector<HTMLButtonElement>('.fam-create-submit')!.disabled).toBe(true);
    set('.fam-majority-date', '2035-01-01');
    for (const selector of ['.fam-declaration', '.fam-consent']) click(selector);
    click('.fam-create-submit');
    await fixture.whenStable();
    expect(fam.createMinor).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'luna',
        country: 'MX',
        majorityAt: '2035-01-01',
        householdId: 'household-a',
        expectedHouseholdRevision: 3,
        policyVersion: 'family-policy-v2',
        declarationVersion: 'declaration-v1',
        consentVersion: 'consent-v1',
      }),
    );
  });

  it('does not reopen a dismissed sheet after a late password reset', async () => {
    const { root, fam, click, fixture } = setup();
    let resolve!: (value: { tempPassword: string }) => void;
    fam.resetChildPassword.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    click('.fam-open');
    click('.fam-reset');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    resolve({ tempPassword: 'never-reveal' });
    await fixture.whenStable();
    expect(root.querySelector('.familia-sheet')).toBeNull();
    expect(root.textContent).not.toContain('never-reveal');
  });

  it('closes an open credential sheet when identity changes', async () => {
    const { root, fam, click, fixture, user } = setup();
    fam.resetChildPassword.mockResolvedValueOnce({ tempPassword: 'private' });
    click('.fam-open');
    click('.fam-reset');
    await fixture.whenStable();
    user.set({ ...adult, userId: 'different-adult' });
    fixture.detectChanges();
    expect(root.querySelector('.familia-sheet')).toBeNull();
  });
});
