import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSED_INDIVIDUAL_BILLING_CATALOG, type IndividualBillingCatalog } from '../api/contracts';
import { API_CLIENT } from '../api/api-client';
import { AuthService } from '../auth/auth.service';
import { PlanCatalogService } from './plan-catalog.service';
import { PUBLIC_INDIVIDUAL_CATALOG } from '../api/public-individual-catalog';

describe('individual catalog compatibility', () => {
  beforeEach(() => TestBed.resetTestingModule());
  it('exposes a closed real individual offer without constructing account services', async () => {
    const auth = vi.fn(() => {
      throw new Error('public catalog started auth');
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useFactory: auth },
        { provide: API_CLIENT, useFactory: auth },
      ],
    });
    const service = TestBed.inject(PlanCatalogService) as PlanCatalogService & {
      individualCatalog?: () => IndividualBillingCatalog | null;
      loadIndividual?: () => Promise<IndividualBillingCatalog | null>;
    };
    await service.loadIndividual?.();
    expect(service.individualCatalog?.()).toEqual(CLOSED_INDIVIDUAL_BILLING_CATALOG);
    expect(auth).not.toHaveBeenCalled();
  });
  it('closes the current offer when an earlier backend still returns legacy individual pricing', async () => {
    const legacy = {
      ...CLOSED_INDIVIDUAL_BILLING_CATALOG,
      catalogVersion: 'individual-mx-2026-10-v1',
      prices: { month: { amountMinor: 9900 }, year: { amountMinor: 94900 } },
      purchasesEnabled: true,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: PUBLIC_INDIVIDUAL_CATALOG, useValue: async () => legacy }],
    });
    const service = TestBed.inject(PlanCatalogService);
    expect(await service.refreshIndividual()).toBeNull();
    expect(service.individualCatalog()).toBeNull();
    expect(service.individualError()).toBe(true);
  });
});
