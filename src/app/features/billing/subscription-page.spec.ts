import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatedRoute } from '@angular/router';
import { API_CLIENT } from '../../core/api/api-client';
import { AccessService } from '../../core/access/access.service';
import { PUBLIC_INDIVIDUAL_CATALOG } from '../../core/api/public-individual-catalog';
import {
  CLOSED_INDIVIDUAL_BILLING_CATALOG,
  createFreeAccessSummary,
  type IndividualBillingSummary,
  type IndividualCheckoutRequest,
} from '../../core/api/contracts';
import { ES } from '../../core/i18n/es';
import { EN } from '../../core/i18n/en';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthService } from '../../core/auth/auth.service';
import { PrivacyService } from '../../core/privacy.service';
import { SubscriptionPage } from './subscription-page';

describe('individual subscription page', () => {
  beforeEach(() => TestBed.resetTestingModule());
  async function adult(
    summary: Partial<IndividualBillingSummary> = {},
    enabled = true,
    returnFrom: string | null = null,
    termsHash = CLOSED_INDIVIDUAL_BILLING_CATALOG.terms.hashes.es,
  ) {
    const current: IndividualBillingSummary = {
      contractVersion: 1,
      state: 'none',
      interval: null,
      paidThrough: null,
      nextRenewalAt: null,
      cancelAtPeriodEnd: false,
      processing: 'idle',
      canCheckout: true,
      canOpenPortal: false,
      revision: 0,
      ...summary,
    };
    const api = {
      getIndividualBillingSummary: vi.fn(async () => current),
      createIndividualCheckout: vi.fn(async (request: IndividualCheckoutRequest) => ({
        outcome: 'pending',
        commandId: request.commandId,
        billingRevision: 1,
        retryAfterMs: 5000,
      })),
      createIndividualPortalSession: vi.fn(),
    };
    const user = signal({ userId: 'buyer', accountType: 'adult' });
    const privacyStatus = signal<{
      scope: 'adult' | 'adolescent_private';
      adultDeclared: boolean;
      cloudConsent?: 'absent';
      canUseCloud?: false;
    } | null>({
      scope: 'adult',
      adultDeclared: true,
      cloudConsent: 'absent',
      canUseCloud: false,
    });
    await TestBed.configureTestingModule({
      imports: [SubscriptionPage],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: new Map([['return', returnFrom]]) } },
        },
        { provide: AuthService, useValue: { user } },
        {
          provide: PrivacyService,
          useValue: { status: privacyStatus, refresh: vi.fn(async () => privacyStatus()) },
        },
        { provide: API_CLIENT, useValue: api },
        {
          provide: AccessService,
          useValue: {
            access: signal(createFreeAccessSummary()),
            refresh: vi.fn(async () => createFreeAccessSummary()),
          },
        },
        {
          provide: PUBLIC_INDIVIDUAL_CATALOG,
          useValue: async () => ({
            ...CLOSED_INDIVIDUAL_BILLING_CATALOG,
            purchasesEnabled: enabled,
            terms: {
              ...CLOSED_INDIVIDUAL_BILLING_CATALOG.terms,
              hashes: { ...CLOSED_INDIVIDUAL_BILLING_CATALOG.terms.hashes, es: termsHash },
            },
          }),
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SubscriptionPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement)
          .querySelector('.billing-status')
          ?.getAttribute('aria-busy'),
      ).toBe('false');
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('details p')?.textContent,
      ).toContain('$114.84 MXN');
    });
    return { fixture, root: fixture.nativeElement as HTMLElement, api, user, privacyStatus };
  }
  it('gives a guest a calm sign-in door back to this subscription route', async () => {
    await TestBed.configureTestingModule({
      imports: [SubscriptionPage],
      providers: [provideRouter([]), { provide: AuthService, useValue: { user: signal(null) } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SubscriptionPage);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent).toContain('Mi suscripción');
    expect(root.querySelector('.billing-sign-in')?.getAttribute('href')).toContain(
      'volver=%2Faccount%2Fsubscription',
    );
    expect(root.querySelector('.billing-checkout')).toBeNull();
  });
  it('requires separate recurring-terms and Mexico choices without optional cloud consent', async () => {
    const { root, fixture } = await adult();
    const checkout = root.querySelector('.billing-checkout') as HTMLButtonElement;
    expect(checkout).not.toBeNull();
    expect(checkout.disabled).toBe(true);
    (root.querySelector('#billing-terms') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(checkout.disabled).toBe(true);
    (root.querySelector('#billing-country') as HTMLInputElement).click();
    fixture.detectChanges();
    expect(checkout.disabled).toBe(false);
    expect(root.textContent).toContain('$114.84 MXN');
    expect(root.textContent).toContain('$1,100.84 MXN');
    expect(root.textContent).toContain(ES.billing.recurring);
  });
  it('keeps Portal visible after expiry with new purchases closed', async () => {
    const { root } = await adult(
      { state: 'expired', canOpenPortal: true, paidThrough: Date.now() - 1000 },
      false,
    );
    expect(root.querySelector('.billing-portal')?.textContent).toContain(ES.billing.portal);
    expect(root.querySelector('.billing-checkout')).toBeNull();
    expect(root.textContent).toContain(ES.billing.purchasesClosed);
  });
  it('hides purchases outside the admitted cohort and keeps Portal independent of admission', async () => {
    const { root, api } = await adult({
      state: 'expired',
      canCheckout: false,
      canOpenPortal: true,
      paidThrough: Date.now() - 1000,
    });
    expect(root.querySelector('form')).toBeNull();
    expect(root.querySelector('.billing-checkout')).toBeNull();
    expect(root.querySelector('.billing-portal')?.textContent).toContain(ES.billing.portal);
    expect(api.createIndividualCheckout).not.toHaveBeenCalled();
  });
  it('does not present another purchase while payment is pending', async () => {
    const { root } = await adult({
      state: 'checkout_pending',
      processing: 'pending',
      canCheckout: false,
    });
    expect(root.querySelector('.billing-checkout')).toBeNull();
    expect(root.textContent).toContain(ES.billing.pending);
  });
  it('treats a forged success return only as a request to refresh summary and access', async () => {
    const { root, api } = await adult({}, true, 'checkout');
    expect(api.getIndividualBillingSummary).toHaveBeenCalled();
    expect(api.createIndividualCheckout).not.toHaveBeenCalled();
    expect(root.textContent).toContain(ES.billing.returnNotice);
    expect(root.textContent).toContain(ES.billing.accessFree);
    expect(root.querySelector('.billing-checkout')).toBeNull();
  });
  it('does not enable purchase against commercial terms different from those displayed', async () => {
    const { root, fixture } = await adult({}, true, null, 'a'.repeat(64));
    (root.querySelector('#billing-terms') as HTMLInputElement).click();
    (root.querySelector('#billing-country') as HTMLInputElement).click();
    fixture.detectChanges();
    expect((root.querySelector('.billing-checkout') as HTMLButtonElement).disabled).toBe(true);
    expect(root.textContent).toContain(ES.billing.catalogUnavailable);
  });
  it('sends the annual interval and exact English terms only after fresh language consent', async () => {
    const { root, fixture, api } = await adult();
    (root.querySelector('#billing-terms') as HTMLInputElement).click();
    (root.querySelector('#billing-country') as HTMLInputElement).click();
    TestBed.inject(I18nService).set('en');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('details p')?.textContent).toBe(EN.billing.termsText);
    });
    expect((root.querySelector('#billing-terms') as HTMLInputElement).checked).toBe(false);
    (root.querySelector('#billing-terms') as HTMLInputElement).click();
    (root.querySelector('input[value="year"]') as HTMLInputElement).click();
    fixture.detectChanges();
    (root.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(api.createIndividualCheckout).toHaveBeenCalledTimes(1));
    expect(api.createIndividualCheckout.mock.calls[0]?.[0]).toMatchObject({
      interval: 'year',
      country: 'MX',
      termsAcceptance: {
        language: 'en',
        accepted: true,
        version: EN.billing.termsVersion,
        hash: CLOSED_INDIVIDUAL_BILLING_CATALOG.terms.hashes.en,
      },
    });
  });
  it('keeps a minor outside the individual purchase form', async () => {
    const { root, fixture, user } = await adult();
    user.set({ userId: 'young', accountType: 'minor' });
    fixture.detectChanges();
    expect(root.querySelector('.billing-checkout')).toBeNull();
    expect(root.textContent).toContain(ES.billing.adultOnly);
  });
  it.each([{ scope: 'adolescent_private', adultDeclared: false }, null] as const)(
    'has no purchase or Portal action while canonical adult admission is absent: %j',
    async (status) => {
      const { root, fixture, api, privacyStatus } = await adult({ canOpenPortal: true });
      privacyStatus.set(status);
      fixture.detectChanges();
      expect(root.querySelector('form')).toBeNull();
      expect(root.querySelector('.billing-checkout')).toBeNull();
      expect(root.querySelector('.billing-portal')).toBeNull();
      if (status === null) expect(root.textContent).toContain(ES.billing.loading);
      expect(api.createIndividualCheckout).not.toHaveBeenCalled();
      expect(api.createIndividualPortalSession).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'keeps Portal for a canonical adult needing renewed declaration, public sales=%s',
    async (enabled) => {
      const { root, fixture, privacyStatus, api } = await adult(
        {
          state: 'expired',
          canCheckout: enabled,
          canOpenPortal: true,
          paidThrough: Date.now() - 1000,
        },
        enabled,
      );
      privacyStatus.set({ scope: 'adult', adultDeclared: false });
      fixture.detectChanges();
      expect(root.querySelector('form')).toBeNull();
      expect(root.querySelector('.billing-checkout')).toBeNull();
      expect(root.querySelector('.billing-portal')).not.toBeNull();
      expect(api.createIndividualCheckout).not.toHaveBeenCalled();
    },
  );
});
