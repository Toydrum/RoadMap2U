import { Injectable, Injector, inject, signal } from '@angular/core';
import { API_CLIENT } from '../api/api-client';
import {
  PREPAYMENT_PLAN_CATALOG,
  isIndividualBillingCatalog,
  type IndividualBillingCatalog,
  type PlanCatalog,
} from '../api/contracts';
import { PUBLIC_INDIVIDUAL_CATALOG } from '../api/public-individual-catalog';

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
 * Keeps the frozen compatibility catalog separate from the strictly validated
 * individual offer. Public reads do not construct identity or product storage.
 */
@Injectable({ providedIn: 'root' })
export class PlanCatalogService {
  private readonly injector = inject(Injector);
  private readonly readIndividual = inject(PUBLIC_INDIVIDUAL_CATALOG);
  private readonly catalogSignal = signal<PlanCatalog>(PREPAYMENT_PLAN_CATALOG);
  private loaded = false;
  private inFlight: Promise<PlanCatalog> | null = null;

  readonly catalog = this.catalogSignal.asReadonly();
  private readonly individualCatalogState = signal<IndividualBillingCatalog | null>(null);
  private readonly individualLoadingState = signal(false);
  private readonly individualErrorState = signal(false);
  readonly individualCatalog = this.individualCatalogState.asReadonly();
  readonly individualLoading = this.individualLoadingState.asReadonly();
  readonly individualError = this.individualErrorState.asReadonly();
  private individualInFlight: Promise<IndividualBillingCatalog | null> | null = null;

  loadIndividual(): Promise<IndividualBillingCatalog | null> {
    return this.individualCatalog()
      ? Promise.resolve(this.individualCatalog())
      : this.refreshIndividual();
  }

  refreshIndividual(): Promise<IndividualBillingCatalog | null> {
    if (this.individualInFlight) return this.individualInFlight;
    this.individualLoadingState.set(true);
    this.individualErrorState.set(false);
    const request = Promise.resolve()
      .then(() => this.readIndividual())
      .then((value) => {
        if (!isIndividualBillingCatalog(value)) throw new Error('invalid individual catalog');
        const catalog = structuredClone(value);
        this.individualCatalogState.set(catalog);
        return catalog;
      })
      .catch(() => {
        // An old open offer cannot survive a failed availability refresh.
        this.individualCatalogState.set(null);
        this.individualErrorState.set(true);
        return null;
      })
      .finally(() => {
        if (this.individualInFlight === request) this.individualInFlight = null;
        this.individualLoadingState.set(false);
      });
    this.individualInFlight = request;
    return request;
  }

  load(): Promise<PlanCatalog> {
    if (this.loaded) return Promise.resolve(this.catalogSignal());
    return this.inFlight ?? this.fetch();
  }

  refresh(): Promise<PlanCatalog> {
    return this.inFlight ?? this.fetch();
  }

  private fetch(): Promise<PlanCatalog> {
    const request = this.injector
      .get(API_CLIENT)
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
