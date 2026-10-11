import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Contracts from './contracts';
import { HttpApi } from './http-api';
import type { AuthProvider } from '../auth/auth-provider';

const checkout = {
  commandId: '00000000-0000-4000-8000-000000000001', expectedBillingRevision: 0,
  interval: 'month', catalogVersion: 'individual-mx-2026-10-v1', country: 'MX',
  termsAcceptance: { version: 'terms-v1', hash: 'a'.repeat(64), language: 'es', accepted: true },
};
const portal = { commandId: checkout.commandId, expectedBillingRevision: 3 };
const summary = {
  contractVersion: 1, state: 'active', interval: 'month', paidThrough: 1_800_000_000_000,
  nextRenewalAt: 1_800_000_000_000, cancelAtPeriodEnd: false, processing: 'idle',
  canCheckout: false, canOpenPortal: true, revision: 3,
};
function accepts(name: string, value: unknown): boolean {
  const guard = (Contracts as unknown as Record<string, unknown>)[name];
  expect(guard, name).toBeTypeOf('function');
  return (guard as (value: unknown) => boolean)(value);
}
afterEach(() => vi.unstubAllGlobals());
describe('individual billing contracts', () => {
  it('accepts the actor-scoped checkout and portal commands without a household', () => {
    expect(accepts('isIndividualCheckoutRequest', checkout)).toBe(true);
    expect(accepts('isIndividualPortalRequest', portal)).toBe(true);
  });
  it.each(['householdId', 'ownerSub', 'customerId', 'subscriptionId', 'priceId', 'amount', 'quantity', 'returnUrl'])('rejects caller supplied %s', (key) => {
    expect(accepts('isIndividualCheckoutRequest', { ...checkout, [key]: 'injected' })).toBe(false);
    expect(accepts('isIndividualPortalRequest', { ...portal, [key]: 'injected' })).toBe(false);
  });
  it('rejects malformed revisions, intervals, country and unaccepted terms', () => {
    for (const patch of [{ expectedBillingRevision: -1 }, { interval: 'week' }, { country: 'US' }, { commandId: '' }, { termsAcceptance: { ...checkout.termsAcceptance, accepted: false } }, { termsAcceptance: { ...checkout.termsAcceptance, hash: 'bad' } }])
      expect(accepts('isIndividualCheckoutRequest', { ...checkout, ...patch })).toBe(false);
  });
  it('keeps the legacy catalog closed and publishes a separate exact individual offer', () => {
    const catalog = (Contracts as unknown as Record<string, unknown>)['CLOSED_INDIVIDUAL_BILLING_CATALOG'];
    expect(accepts('isIndividualBillingCatalog', catalog)).toBe(true);
    expect(catalog).toMatchObject({ country: 'MX', currency: 'MXN', taxInclusive: true, purchasesEnabled: false, offerKey: 'premium_individual', prices: { month: { amountMinor: 9900 }, year: { amountMinor: 94900 } } });
    expect(Contracts.PREPAYMENT_PLAN_CATALOG.paymentsEnabled).toBe(false);
    expect(accepts('isIndividualBillingCatalog', { ...(catalog as object), customerId: 'injected' })).toBe(false);
  });
  it('validates finite paid periods and closed processing/state vocabularies without grace', () => {
    expect(accepts('isIndividualBillingSummary', summary)).toBe(true);
    for (const patch of [{ paidThrough: Infinity }, { revision: NaN }, { state: 'past_due_grace' }, { processing: 'grant' }, { householdId: 'family' }, { ownerSub: 'other' }])
      expect(accepts('isIndividualBillingSummary', { ...summary, ...patch })).toBe(false);
  });
  it('validates recoverable pending and safe hosted redirects', () => {
    const redirect = { outcome: 'redirect', commandId: checkout.commandId, billingRevision: 2, url: 'https://checkout.stripe.com/c/pay/test', expiresAt: 1_800_000_000_000 };
    expect(accepts('isIndividualBillingCommandResult', redirect)).toBe(true);
    expect(accepts('isIndividualBillingCommandResult', { outcome: 'pending', commandId: checkout.commandId, billingRevision: 2, retryAfterMs: 3000 })).toBe(true);
    for (const url of ['javascript:alert(1)', 'http://checkout.stripe.com/c/pay/test', 'https://evil.example/c/pay/test', 'https://checkout.stripe.com.evil.example/c/pay/test'])
      expect(accepts('isIndividualBillingCommandResult', { ...redirect, url })).toBe(false);
  });
  it('routes catalog without auth and all account operations through the authenticated seam', async () => {
    const request = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', request);
    const token = vi.fn(async () => 'verified-actor');
    const api = new HttpApi({ idToken: token } as unknown as AuthProvider) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const [name, body] of [['getIndividualBillingCatalog', undefined], ['getIndividualBillingSummary', undefined], ['createIndividualCheckout', checkout], ['createIndividualPortalSession', portal]] as const) {
      expect(api[name], name).toBeTypeOf('function');
      // Transport rejects malformed responses independently of endpoint routing.
      await api[name](...(body ? [body] : [])).catch(() => undefined);
    }
    expect(request.mock.calls.map((call) => String((call as unknown[])[0]).split('/v1')[1])).toEqual(['/billing/individual/catalog', '/billing/individual/summary', '/billing/individual/checkout', '/billing/individual/portal']);
    expect(token).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.slice(2).map((call) => JSON.parse(String((call as unknown[])[1] && ((call as unknown[])[1] as RequestInit).body)))).toEqual([checkout, portal]);
  });
});
