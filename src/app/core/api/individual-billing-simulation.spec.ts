import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_CLIENT } from './api-client';
import { BILLING_SIMULATION_STAGE } from './billing-simulation';
import { BILLING_RUNTIME, IndividualBillingService } from './individual-billing.service';
import { ACCESS_RUNTIME, ACCESS_CACHE, AccessService } from '../access/access.service';
import { AuthService } from '../auth/auth.service';
import {
  PREPAYMENT_PLAN_CATALOG,
  type AccessSummary,
  type IndividualBillingSummary,
} from './contracts';
const NOW = 1_800_000_000_000,
  FROZEN = NOW - 86400000;
function setup(stage = 'dev', clockRevision = 2) {
  const simulation = {
    stage: 'dev' as const,
    mode: 'ready' as const,
    frozenAt: FROZEN,
    clockRevision: 2,
    observedAt: NOW,
    evidenceValidUntil: NOW + 30000,
  };
  const access: AccessSummary = {
    effectivePlanKey: 'premium',
    catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active',
    activeSources: [
      {
        kind: 'subscription',
        scope: 'individual',
        sourceId: 'individual:synthetic',
        planKey: 'premium',
        validUntil: FROZEN + 3600000,
      },
    ],
    limits: { maxActiveTrees: null, maxVisibleBranchesPerTree: null },
    capabilities: { cloudSync: true, social: true, family: false },
    usage: { activeTrees: 0, visibleBranchesByTree: {} },
    revision: 4,
    nextRecomputeAt: NOW + 30000,
    offlineValidUntil: NOW,
    simulation: { ...simulation, clockRevision },
  };
  const summary: IndividualBillingSummary = {
    contractVersion: 1,
    state: 'active',
    interval: 'month',
    paidThrough: FROZEN + 3600000,
    nextRenewalAt: FROZEN + 3600000,
    cancelAtPeriodEnd: false,
    processing: 'idle',
    canCheckout: false,
    canOpenPortal: true,
    revision: 3,
    simulation,
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: BILLING_SIMULATION_STAGE, useValue: stage },
      { provide: AuthService, useValue: { user: signal({ userId: 'qa' }) } },
      {
        provide: API_CLIENT,
        useValue: {
          getAccess: async () => access,
          getIndividualBillingSummary: async () => summary,
        },
      },
      { provide: ACCESS_CACHE, useValue: { read: async () => null, write: async () => {} } },
      { provide: BILLING_RUNTIME, useValue: { now: () => NOW, schedule: () => () => {} } },
      {
        provide: ACCESS_RUNTIME,
        useValue: {
          now: () => NOW,
          isOnline: () => true,
          listenOnline: () => () => {},
          scheduleEvery: () => () => {},
          scheduleOnce: () => () => {},
        },
      },
    ],
  });
  return {
    billing: TestBed.inject(IndividualBillingService),
    access: TestBed.inject(AccessService),
  };
}
afterEach(() => TestBed.resetTestingModule());
describe('confirmation uses the same server financial clock', () => {
  it('finishes the read-only confirmation with paid access in simulated past time', async () => {
    const f = setup();
    await f.billing.confirm();
    expect(f.access.access().effectivePlanKey).toBe('premium');
    expect(f.billing.confirmation()).toBe('idle');
  });
  it('waits for matching clock revisions across access and billing reads', async () => {
    const f = setup('dev', 3);
    await f.billing.confirm();
    expect(f.billing.confirmation()).toBe('checking');
  });
  it('rejects synthetic metadata in the production build', async () => {
    const f = setup('prod');
    await f.billing.refresh();
    expect(f.billing.summary()).toBeNull();
    expect(f.billing.error()).toBe('unknown');
  });
});
