import { describe, expect, it } from 'vitest';
import { isIndividualBillingSummary } from './contracts';

const now = 1_800_000_000_000;
const summary = {
  contractVersion: 1,
  state: 'active',
  interval: 'month',
  paidThrough: now + 86400000,
  nextRenewalAt: now + 86400000,
  cancelAtPeriodEnd: false,
  processing: 'idle',
  canCheckout: false,
  canOpenPortal: true,
  revision: 8,
};
const simulation = {
  stage: 'dev',
  mode: 'ready',
  frozenAt: now + 3600000,
  clockRevision: 2,
  observedAt: now,
  evidenceValidUntil: now + 900000,
};

describe('public temporal billing presentation', () => {
  it.each(['dev', 'test'])('accepts the additive %s synthetic clock metadata', (stage) => {
    expect(isIndividualBillingSummary({ ...summary, simulation: { ...simulation, stage } })).toBe(
      true,
    );
  });
  it('accepts unavailable evidence without a guessed financial date', () => {
    expect(
      isIndividualBillingSummary({
        ...summary,
        state: 'payment_review',
        processing: 'review',
        simulation: {
          ...simulation,
          mode: 'unavailable',
          frozenAt: null,
          evidenceValidUntil: null,
        },
      }),
    ).toBe(true);
  });
  it.each([
    { stage: 'prod' },
    { stage: 'local' },
    { mode: 'real' },
    { clockRevision: 0 },
    { clockRevision: 1.5 },
    { frozenAt: null },
    { frozenAt: Infinity },
    { evidenceValidUntil: now },
    { evidenceValidUntil: now + 900001 },
    { observedAt: -1 },
    { customerId: 'cus_private' },
    { secret: 'rk_test_private' },
  ])('rejects malformed or private metadata %j', (patch) => {
    expect(
      isIndividualBillingSummary({ ...summary, simulation: { ...simulation, ...patch } }),
    ).toBe(false);
  });
  it('preserves the ordinary response shape', () =>
    expect(isIndividualBillingSummary(summary)).toBe(true));
});
