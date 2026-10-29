import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatedRoute } from '@angular/router';
import { API_CLIENT } from '../../core/api/api-client';
import { billingDocument } from '../../core/api/billing-document';
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
import { BILLING_SIMULATION_STAGE } from '../../core/api/billing-simulation';

describe('individual subscription page', () => {
  beforeEach(() => TestBed.resetTestingModule());
  async function adult(
    summary: Partial<IndividualBillingSummary> = {},
    enabled = true,
    returnFrom: string | null = null,
    termsHash?: string,
    stage = 'local',
    termsVersion = ES.billing.termsVersion,
  ) {
    const [esTerms, enTerms] = await Promise.all([billingDocument('es'), billingDocument('en')]);
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
    const accessState = {
      access: signal(createFreeAccessSummary()),
      leaseState: signal<'valid' | 'fallback'>('valid'),
      loading: signal(false),
      lastError: signal<string | null>(null),
      start: vi.fn(async () => undefined),
      refresh: vi.fn(async () => createFreeAccessSummary()),
    };
    await TestBed.configureTestingModule({
      imports: [SubscriptionPage],
      providers: [
        { provide: BILLING_SIMULATION_STAGE, useValue: stage },
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
          useValue: accessState,
        },
        {
          provide: PUBLIC_INDIVIDUAL_CATALOG,
          useValue: async () => ({
            ...CLOSED_INDIVIDUAL_BILLING_CATALOG,
            purchasesEnabled: enabled,
            terms: {
              ...CLOSED_INDIVIDUAL_BILLING_CATALOG.terms,
              version: termsVersion,
              hashes: { es: termsHash ?? esTerms.hash, en: enTerms.hash },
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
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      api,
      user,
      privacyStatus,
      accessState,
    };
  }
  it('does not present a fallback as confirmed Free after an access read fails', async () => {
    const { fixture, root, accessState } = await adult();
    accessState.leaseState.set('fallback');
    accessState.lastError.set('offline');
    fixture.detectChanges();
    expect(root.textContent).not.toContain(ES.accountStatus.free);
    expect(root.textContent).toContain('No se pudo confirmar tu acceso');
  });
  it('identifies permanent sponsorship separately from a paid subscription', async () => {
    const { fixture, root, accessState } = await adult({ state: 'active', canOpenPortal: true });
    accessState.access.set({
      ...createFreeAccessSummary(),
      effectivePlanKey: 'premium',
      activeSources: [
        { kind: 'sponsored', sourceId: 'demo-sponsor', planKey: 'premium', validUntil: null },
        {
          kind: 'subscription',
          sourceId: 'demo-subscription',
          scope: 'individual',
          planKey: 'premium',
          validUntil: Date.now() + 86400000,
        },
      ],
    });
    fixture.detectChanges();
    expect(root.textContent).toContain('Premium patrocinado · sin vencimiento');
    expect(root.textContent).toContain('Premium por suscripción');
    expect(root.querySelector('.billing-portal')).not.toBeNull();
  });
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
  it('labels a synthetic DEV financial date in Spanish and English without provider identifiers', async () => {
    const now = Date.now(),
      simulation = {
        stage: 'dev' as const,
        mode: 'ready' as const,
        frozenAt: now - 86400000,
        clockRevision: 2,
        observedAt: now,
        evidenceValidUntil: now + 30000,
      };
    const { root, fixture } = await adult({ simulation }, true, null, undefined, 'dev');
    expect(root.querySelector('.billing-simulation')?.textContent).toContain('Ensayo');
    expect(root.querySelector('.billing-simulation')?.textContent).toContain('fecha financiera');
    await TestBed.inject(I18nService).set('en');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('.billing-simulation')?.textContent).toContain('Simulation');
    });
    expect(root.querySelector('.billing-simulation')?.textContent).toContain('financial date');
    expect(root.querySelector('.billing-simulation')?.textContent).not.toMatch(/clock_|cus_|acct_/);
  });
  it('shows unavailable synthetic evidence without inventing a financial date', async () => {
    const now = Date.now(),
      simulation = {
        stage: 'test' as const,
        mode: 'unavailable' as const,
        frozenAt: null,
        clockRevision: 2,
        observedAt: now,
        evidenceValidUntil: null,
      };
    const { root } = await adult(
      { state: 'payment_review', processing: 'review', simulation },
      true,
      null,
      undefined,
      'test',
    );
    expect(root.querySelector('.billing-simulation')?.textContent).toContain('esperamos');
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
  it.each([
    {
      lang: 'es' as const,
      label: 'Solicitar factura',
      fields: [
        'RFC',
        'nombre o razón social',
        'código postal fiscal',
        'régimen fiscal',
        'uso del CFDI',
        'forma de pago',
        'correo para recibir XML y PDF',
      ],
    },
    {
      lang: 'en' as const,
      label: 'Request an invoice',
      fields: [
        'RFC',
        'registered name or business name',
        'tax postcode',
        'tax regime',
        'CFDI use',
        'payment method',
        'email for XML and PDF delivery',
      ],
    },
  ])(
    'keeps the invoice email and all required tax details available in $lang',
    async ({ lang, label, fields }) => {
      const { root, fixture, api } = await adult({ state: 'expired', canCheckout: false }, false);
      await TestBed.inject(I18nService).set(lang);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(root.querySelector('.billing-invoice')?.textContent?.trim()).toBe(label);
      });
      const link = root.querySelector('.billing-invoice') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('mailto:jescricdy1@gmail.com');
      const support = root.querySelector('.billing-support')?.textContent ?? '';
      expect(support).toContain('jescricdy1@gmail.com');
      for (const field of fields) expect(support).toContain(field);
      expect(root.querySelector('.billing-checkout')).toBeNull();
      expect(api.createIndividualCheckout).not.toHaveBeenCalled();
    },
  );
  it.each([
    { lang: 'es' as const, label: 'Solicitar factura', annual: 'factura anual' },
    { lang: 'en' as const, label: 'Request an invoice', annual: 'annual invoice' },
  ])(
    'explains that the annual purchase receives an annual invoice in $lang',
    async ({ lang, label, annual }) => {
      const { root, fixture } = await adult({}, false);
      await TestBed.inject(I18nService).set(lang);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(root.querySelector('.billing-invoice')?.textContent?.trim()).toBe(label);
      });
      expect(root.querySelector('.billing-support')?.textContent).toContain(annual);
    },
  );
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
    expect(root.textContent).toContain(ES.accountStatus.free);
    expect(root.querySelector('.billing-checkout')).toBeNull();
  });
  it.each([
    { mismatch: 'hash', termsHash: 'a'.repeat(64), termsVersion: ES.billing.termsVersion },
    {
      mismatch: 'version',
      termsHash: undefined,
      termsVersion: 'individual-subscription-2026-10-12-draft-v2',
    },
  ])(
    'does not enable purchase against a different terms $mismatch',
    async ({ termsHash, termsVersion }) => {
      const { root, fixture, api } = await adult({}, true, null, termsHash, 'local', termsVersion);
      (root.querySelector('#billing-terms') as HTMLInputElement).click();
      (root.querySelector('#billing-country') as HTMLInputElement).click();
      fixture.detectChanges();
      expect((root.querySelector('.billing-checkout') as HTMLButtonElement).disabled).toBe(true);
      expect(root.textContent).toContain(ES.billing.catalogUnavailable);
      (root.querySelector('form') as HTMLFormElement).dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      expect(api.createIndividualCheckout).not.toHaveBeenCalled();
    },
  );
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
        hash: (await billingDocument('en')).hash,
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
