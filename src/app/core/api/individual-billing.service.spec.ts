import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../auth/auth.service';
import { AccessService } from '../access/access.service';
import {
  quiesceAccountClosureWrites,
  resumeAccountClosureWritesLocally,
} from '../db/account-closure-fence';
import { API_CLIENT } from './api-client';
import {
  ApiError,
  CLOSED_INDIVIDUAL_BILLING_CATALOG,
  createFreeAccessSummary,
  type IndividualBillingSummary,
  type IndividualCheckoutRequest,
} from './contracts';
import {
  BILLING_CONFIRMATION_MS,
  BILLING_NAVIGATION,
  IndividualBillingService,
} from './individual-billing.service';

function summary(overrides: Partial<IndividualBillingSummary> = {}): IndividualBillingSummary {
  return {
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
    ...overrides,
  };
}
const input: Omit<IndividualCheckoutRequest, 'commandId' | 'expectedBillingRevision'> = {
  interval: 'month',
  catalogVersion: CLOSED_INDIVIDUAL_BILLING_CATALOG.catalogVersion,
  country: 'MX',
  termsAcceptance: {
    version: CLOSED_INDIVIDUAL_BILLING_CATALOG.terms.version,
    hash: CLOSED_INDIVIDUAL_BILLING_CATALOG.terms.hashes.es,
    language: 'es',
    accepted: true,
  },
};
function setup() {
  const user = signal<{ userId: string } | null>({ userId: 'buyer' });
  const api = {
    getIndividualBillingSummary: vi.fn(async () => summary()),
    createIndividualCheckout: vi.fn(async (req: IndividualCheckoutRequest) => ({
      outcome: 'redirect' as const,
      commandId: req.commandId,
      billingRevision: 1,
      url: 'https://checkout.stripe.com/c/pay/synthetic',
      expiresAt: Date.now() + 60_000,
    })),
    createIndividualPortalSession: vi.fn(),
  };
  const access = {
    access: signal(createFreeAccessSummary()),
    refresh: vi.fn(async () => createFreeAccessSummary()),
  };
  const navigation = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: API_CLIENT, useValue: api },
      { provide: AuthService, useValue: { user } },
      { provide: AccessService, useValue: access },
      { provide: BILLING_NAVIGATION, useValue: navigation },
    ],
  });
  const service = TestBed.inject(IndividualBillingService);
  TestBed.tick();
  return { service, api, access, user, navigation };
}
describe('individual billing read and command boundaries', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    resumeAccountClosureWritesLocally();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    resumeAccountClosureWritesLocally();
    vi.useRealTimers();
  });
  it('closes new purchase after a failed authoritative summary refresh', async () => {
    const { service, api } = setup();
    await service.refresh();
    expect(service.canCheckout()).toBe(true);
    api.getIndividualBillingSummary.mockRejectedValue(new ApiError('offline'));
    await service.refresh();
    expect(service.canCheckout()).toBe(false);
  });
  it('quiesces billing commands and discards an already-running redirect during terminal closure', async () => {
    const { service, api, navigation } = setup();
    await service.refresh();
    let complete!: (value: Awaited<ReturnType<typeof api.createIndividualCheckout>>) => void;
    api.createIndividualCheckout.mockImplementation(
      (req) =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              outcome: 'redirect',
              commandId: req.commandId,
              billingRevision: 1,
              url: 'https://checkout.stripe.com/c/pay/synthetic',
              expiresAt: Date.now() + 60_000,
            });
        }),
    );
    const checkout = service.checkout(input);
    quiesceAccountClosureWrites();
    complete({} as Awaited<ReturnType<typeof api.createIndividualCheckout>>);
    await checkout;
    expect(navigation).not.toHaveBeenCalled();
    expect(service.canCheckout()).toBe(false);
  });
  it('polls only reads at spaced intervals for at most sixty seconds, then offers an explicit retry', async () => {
    vi.useFakeTimers();
    const { service, api, access } = setup();
    await service.confirm();
    await vi.advanceTimersByTimeAsync(BILLING_CONFIRMATION_MS);
    expect(service.confirmation()).toBe('waiting');
    expect(service.canCheckout()).toBe(false);
    expect(api.getIndividualBillingSummary.mock.calls.length).toBeGreaterThan(1);
    expect(api.getIndividualBillingSummary.mock.calls.length).toBeLessThanOrEqual(13);
    expect(access.refresh).toHaveBeenCalledTimes(api.getIndividualBillingSummary.mock.calls.length);
    const reads = api.getIndividualBillingSummary.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.getIndividualBillingSummary).toHaveBeenCalledTimes(reads);
    expect(api.createIndividualCheckout).not.toHaveBeenCalled();
  });
  it('blocks a second simultaneous click and redirects using only the command result', async () => {
    const { service, api, navigation } = setup();
    await service.refresh();
    const first = service.checkout(input);
    const second = service.checkout(input);
    await Promise.all([first, second]);
    expect(api.createIndividualCheckout).toHaveBeenCalledTimes(1);
    expect(api.createIndividualCheckout.mock.calls[0]?.[0]).toMatchObject({
      ...input,
      expectedBillingRevision: 0,
    });
    expect(navigation).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/synthetic');
  });
  it('releases the refresh control when access transport never finishes', async () => {
    vi.useFakeTimers();
    const { service, access } = setup();
    access.refresh.mockImplementation(() => new Promise(() => undefined));
    const refresh = service.refresh();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(service.loading()).toBe(false);
    await refresh;
  });
  it('rejects a manipulated redirect and never derives paid access from it', async () => {
    const { service, api, navigation, access } = setup();
    await service.refresh();
    api.createIndividualCheckout.mockImplementation(async (req) => ({
      outcome: 'redirect',
      commandId: req.commandId,
      billingRevision: 1,
      url: 'https://checkout.stripe.com.evil.invalid/pay',
      expiresAt: Date.now() + 60_000,
    }));
    await service.checkout(input);
    expect(navigation).not.toHaveBeenCalled();
    expect(service.pending()).toBe(true);
    expect(access.access().effectivePlanKey).toBe('free');
  });
  it('does not publish a retired account summary into the next account', async () => {
    const { service, api, user } = setup();
    let complete!: (value: IndividualBillingSummary) => void;
    api.getIndividualBillingSummary.mockImplementation(
      () => new Promise((resolve) => (complete = resolve)),
    );
    const refresh = service.refresh();
    user.set({ userId: 'other' });
    TestBed.tick();
    complete(summary({ state: 'active', canCheckout: false, canOpenPortal: true }));
    await refresh;
    expect(service.summary()).toBeNull();
  });

  it('retires an uncertain checkout only after a newer terminal summary and uses a fresh intention', async () => {
    vi.useFakeTimers();
    const { service, api } = setup();
    await service.refresh();
    api.createIndividualCheckout.mockRejectedValueOnce(new ApiError('offline'));
    api.getIndividualBillingSummary.mockResolvedValue(
      summary({
        state: 'checkout_pending',
        processing: 'pending',
        canCheckout: false,
        revision: 1,
      }),
    );
    await service.checkout(input);
    const original = api.createIndividualCheckout.mock.calls[0]![0];
    await vi.advanceTimersByTimeAsync(BILLING_CONFIRMATION_MS);
    expect(service.canCheckout()).toBe(false);

    api.getIndividualBillingSummary.mockResolvedValue(summary({ revision: 2 }));
    await service.confirm();
    expect(service.confirmation()).toBe('idle');
    expect(service.canCheckout()).toBe(true);
    await service.checkout({ ...input, interval: 'year' });
    const next = api.createIndividualCheckout.mock.calls[1]![0];
    expect(next.commandId).not.toBe(original.commandId);
    expect(next).toMatchObject({ interval: 'year', expectedBillingRevision: 2 });
  });

  it('keeps an uncertain intention when the expired summary is stale or its revision did not advance', async () => {
    vi.useFakeTimers();
    const { service, api } = setup();
    api.getIndividualBillingSummary.mockResolvedValue(summary({ state: 'expired', revision: 4 }));
    await service.refresh();
    api.createIndividualCheckout.mockRejectedValueOnce(new ApiError('offline'));
    await service.checkout(input);
    await vi.advanceTimersByTimeAsync(BILLING_CONFIRMATION_MS);
    expect(service.confirmation()).toBe('waiting');
    expect(service.canCheckout()).toBe(false);

    api.getIndividualBillingSummary.mockResolvedValue(summary({ revision: 3 }));
    await service.confirm();
    expect(service.canCheckout()).toBe(false);
    expect(service.summary()?.revision).toBe(4);
    api.getIndividualBillingSummary.mockResolvedValue(summary({ state: 'expired', revision: 5 }));
    await service.confirm();
    expect(service.confirmation()).toBe('idle');
    expect(service.canCheckout()).toBe(true);
    await service.checkout(input);
    expect(api.createIndividualCheckout.mock.calls[1]![0].commandId).not.toBe(
      api.createIndividualCheckout.mock.calls[0]![0].commandId,
    );
  });

  it('does not retire a command using a summary read while its transport is still in flight', async () => {
    const { service, api } = setup();
    await service.refresh();
    let complete!: () => void;
    api.createIndividualCheckout.mockImplementationOnce(
      (req) =>
        new Promise((resolve) => {
          complete = () =>
            resolve({
              outcome: 'redirect',
              commandId: req.commandId,
              billingRevision: 1,
              url: 'https://checkout.stripe.com/c/pay/synthetic',
              expiresAt: Date.now() + 60_000,
            });
        }),
    );
    const purchase = service.checkout(input);
    let readComplete!: (value: IndividualBillingSummary) => void;
    api.getIndividualBillingSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          readComplete = resolve;
        }),
    );
    const oldRead = service.refresh();
    expect(service.canCheckout()).toBe(false);
    complete();
    await purchase;
    readComplete(summary({ revision: 3 }));
    await oldRead;
    await service.checkout({ ...input, interval: 'year' });
    expect(api.createIndividualCheckout.mock.calls[1]![0]).toEqual(
      api.createIndividualCheckout.mock.calls[0]![0],
    );
    api.getIndividualBillingSummary.mockResolvedValue(summary({ revision: 4 }));
    await service.refresh();
    await service.checkout({ ...input, interval: 'year' });
    expect(api.createIndividualCheckout.mock.calls[2]![0]).toMatchObject({
      interval: 'year',
      expectedBillingRevision: 4,
    });
    expect(api.createIndividualCheckout.mock.calls[2]![0].commandId).not.toBe(
      api.createIndividualCheckout.mock.calls[0]![0].commandId,
    );
  });

  it('recognizes server-confirmed reservation expiry after a fresh checkout return', async () => {
    const { service, api } = setup();
    api.getIndividualBillingSummary.mockResolvedValue(summary({ revision: 3 }));
    await service.confirm();
    expect(service.confirmation()).toBe('idle');
    expect(service.canCheckout()).toBe(true);
    expect(api.createIndividualCheckout).not.toHaveBeenCalled();
  });
});
