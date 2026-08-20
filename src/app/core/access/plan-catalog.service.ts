import { Injectable, inject, signal } from '@angular/core';
import { API_CLIENT } from '../api/api-client';
import { PREPAYMENT_PLAN_CATALOG, type PlanCatalog } from '../api/contracts';

function isLaunchCatalog(value: unknown): value is PlanCatalog {
  if (!value || typeof value !== 'object') return false;
  const catalog = value as Partial<PlanCatalog>;
  const free = catalog.plans?.free;
  const premium = catalog.plans?.premium;
  return (
    catalog.version === PREPAYMENT_PLAN_CATALOG.version &&
    catalog.pricingVersion === PREPAYMENT_PLAN_CATALOG.pricingVersion &&
    catalog.currency === 'MXN' &&
    catalog.taxInclusive === true &&
    catalog.paymentsEnabled === false &&
    free?.limits?.maxActiveTrees === 2 &&
    free?.limits?.maxVisibleBranchesPerTree === 10 &&
    free?.capabilities?.cloudSync === false &&
    free?.capabilities?.social === false &&
    free?.capabilities?.family === false &&
    premium?.limits?.maxActiveTrees === null &&
    premium?.limits?.maxVisibleBranchesPerTree === null &&
    premium?.capabilities?.cloudSync === true &&
    premium?.capabilities?.social === true &&
    premium?.capabilities?.family === false &&
    premium?.prices?.month?.amountMinor === 9900 &&
    premium?.prices?.year?.amountMinor === 94900
  );
}

/**
 * Public catalog facade. The launch catalog is compiled and immutable; the
 * network response can confirm it, but can never switch payments on or alter
 * the approved prices in a running client.
 */
@Injectable({ providedIn: 'root' })
export class PlanCatalogService {
  private readonly api = inject(API_CLIENT);
  private readonly catalogSignal = signal<PlanCatalog>(PREPAYMENT_PLAN_CATALOG);
  private loaded = false;
  private inFlight: Promise<PlanCatalog> | null = null;

  readonly catalog = this.catalogSignal.asReadonly();

  load(): Promise<PlanCatalog> {
    if (this.loaded) return Promise.resolve(this.catalogSignal());
    return this.inFlight ?? this.fetch();
  }

  refresh(): Promise<PlanCatalog> {
    return this.inFlight ?? this.fetch();
  }

  private fetch(): Promise<PlanCatalog> {
    const request = this.api
      .getPlans()
      .then((catalog) => {
        if (!isLaunchCatalog(catalog)) throw new Error('invalid plan catalog');
        // Canonicalize to the frozen client constant so extra wire fields and
        // mutable response objects never become application configuration.
        this.catalogSignal.set(PREPAYMENT_PLAN_CATALOG);
        this.loaded = true;
        return PREPAYMENT_PLAN_CATALOG;
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }
}
