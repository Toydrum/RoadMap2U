import { ApiError, CLOSED_INDIVIDUAL_BILLING_CATALOG, type AccessSource, type IndividualBillingCatalog, type IndividualBillingCommandResult, type IndividualBillingSummary, type IndividualCheckoutRequest, type IndividualPortalRequest } from './contracts';
import { mockGet, mockPut, type MockUserRow } from './mock-cloud';

/** Provider facts exist only as explicit synthetic-cloud fixtures, never as URL parameters. */
interface PaymentEvidence {
  source: 'test_seed'; accountId: string; accountInstanceId: string; invoiceId: string;
  interval: 'month' | 'year'; paidThrough: number; cancelAtPeriodEnd: boolean;
  revision: number; review?: boolean; terminal?: boolean;
}
interface Operation { request: string; result: IndividualBillingCommandResult }
const keyFor = (user: MockUserRow) => `${user.userId}:${user.accountInstanceId}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  return JSON.stringify(value);
}
export class MockIndividualBilling {
  constructor(private readonly purchasesEnabled: boolean) {}
  catalog(): IndividualBillingCatalog {
    return structuredClone({ ...CLOSED_INDIVIDUAL_BILLING_CATALOG, purchasesEnabled: this.purchasesEnabled });
  }
  private async evidence(user: MockUserRow): Promise<PaymentEvidence | undefined> {
    const raw = (await mockGet<{ value: PaymentEvidence }>('kv', `billing.individual.evidence:${keyFor(user)}`))?.value;
    return raw?.source === 'test_seed' && raw.accountId === user.userId && raw.accountInstanceId === user.accountInstanceId &&
      typeof raw.invoiceId === 'string' && raw.invoiceId.length > 0 && ['month', 'year'].includes(raw.interval) &&
      Number.isSafeInteger(raw.paidThrough) && raw.paidThrough >= 0 && Number.isSafeInteger(raw.revision) && raw.revision >= 1 &&
      typeof raw.cancelAtPeriodEnd === 'boolean' ? raw : undefined;
  }
  async summary(user: MockUserRow): Promise<IndividualBillingSummary> {
    const evidence = await this.evidence(user);
    const pending = (await mockGet<{ value: number }>('kv', `billing.individual.pending:${keyFor(user)}`))?.value;
    const current = !!evidence && evidence.paidThrough > Date.now();
    return {
      contractVersion: 1,
      state: evidence?.review ? 'payment_review' : evidence ? (current ? (evidence.cancelAtPeriodEnd ? 'cancel_at_period_end' : 'active') : 'expired') : pending ? 'checkout_pending' : 'none',
      interval: evidence?.interval ?? null, paidThrough: evidence?.paidThrough ?? null,
      nextRenewalAt: current && !evidence!.cancelAtPeriodEnd ? evidence!.paidThrough : null,
      cancelAtPeriodEnd: evidence?.cancelAtPeriodEnd ?? false,
      processing: evidence?.review ? 'review' : !evidence && pending ? 'pending' : 'idle',
      canCheckout: this.purchasesEnabled && !pending && (!evidence || evidence.terminal === true) && !evidence?.review,
      canOpenPortal: !!evidence, revision: Math.max(evidence?.revision ?? 0, pending ? 1 : 0),
    };
  }
  async source(user: MockUserRow): Promise<AccessSource | null> {
    const evidence = await this.evidence(user);
    if (user.accountType !== 'adult' || !evidence || evidence.review || evidence.paidThrough <= Date.now()) return null;
    return { kind: 'subscription', sourceId: `mock:${evidence.invoiceId}`, planKey: 'premium', scope: 'individual', validUntil: evidence.paidThrough };
  }
  async command(user: MockUserRow, request: IndividualCheckoutRequest | IndividualPortalRequest, kind: 'checkout' | 'portal'): Promise<IndividualBillingCommandResult> {
    const key = `billing.individual.command:${keyFor(user)}:${request.commandId}`;
    const intent = canonical({ kind, request });
    const previous = (await mockGet<{ value: Operation }>('kv', key))?.value;
    if (previous) {
      if (previous.request !== intent) throw new ApiError('CONFLICT');
      return previous.result;
    }
    const summary = await this.summary(user);
    if (summary.revision !== request.expectedBillingRevision) throw new ApiError('BILLING_REVISION_CONFLICT');
    if (kind === 'checkout') {
      const checkout = request as IndividualCheckoutRequest; const catalog = this.catalog();
      if (checkout.catalogVersion !== catalog.catalogVersion || checkout.termsAcceptance.version !== catalog.terms.version || checkout.termsAcceptance.hash !== catalog.terms.hashes[checkout.termsAcceptance.language]) throw new ApiError('BILLING_TERMS_OUTDATED');
      if (!this.purchasesEnabled) throw new ApiError('PAYMENT_REQUIRED');
      if (summary.processing === 'review') throw new ApiError('BILLING_PAYMENT_REVIEW');
      if (!summary.canCheckout) throw new ApiError(summary.processing === 'pending' ? 'CHECKOUT_IN_PROGRESS' : 'BILLING_SUBSCRIPTION_EXISTS');
    } else if (!summary.canOpenPortal) throw new ApiError('NOT_FOUND');
    const result: IndividualBillingCommandResult = {
      outcome: 'redirect', commandId: request.commandId, billingRevision: summary.revision + 1,
      url: `https://${kind === 'checkout' ? 'checkout' : 'billing'}.stripe.com/${kind === 'checkout' ? 'c/pay' : 'p/session'}/synthetic-${encodeURIComponent(request.commandId)}`,
      expiresAt: Date.now() + 30 * 60000,
    };
    await mockPut('kv', { key, value: { request: intent, result } satisfies Operation });
    if (kind === 'checkout') await mockPut('kv', { key: `billing.individual.pending:${keyFor(user)}`, value: true });
    return result;
  }
}
