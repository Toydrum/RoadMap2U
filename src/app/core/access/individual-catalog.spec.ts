import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSED_INDIVIDUAL_BILLING_CATALOG, type IndividualBillingCatalog } from '../api/contracts';
import { API_CLIENT } from '../api/api-client';
import { AuthService } from '../auth/auth.service';
import { PlanCatalogService } from './plan-catalog.service';

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
});
