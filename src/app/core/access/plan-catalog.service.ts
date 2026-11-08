import { Injectable, inject, signal } from '@angular/core';
import {
  PREPAYMENT_PLAN_CATALOG,
  REDUCED_PLAN_CATALOG,
  isFreeLimits,
  CURRENT_INDIVIDUAL_BILLING_CATALOG_VERSION,
  isIndividualBillingCatalog,
  type IndividualBillingCatalog,
  type PlanCatalog,
} from '../api/contracts';
import { PUBLIC_INDIVIDUAL_CATALOG, PUBLIC_PLAN_CATALOG } from '../api/public-individual-catalog';

function launchCatalog(value: unknown): PlanCatalog {
  if (!value || typeof value !== 'object') throw new Error('invalid plan catalog');
  const catalog = value as Omit<Partial<PlanCatalog>, 'version' | 'pricingVersion'> & {
    version?: string;
    pricingVersion?: string;
  };
  const free = catalog.plans?.free;
  const premium = catalog.plans?.premium;
  const supportedVersion =
    (catalog.version === PREPAYMENT_PLAN_CATALOG.version &&
      catalog.pricingVersion === PREPAYMENT_PLAN_CATALOG.pricingVersion) ||
    (catalog.version === '2026-08-prepayment-v1' && catalog.pricingVersion === 'launch-2026');
  if (!(
    supportedVersion &&
    catalog.currency === 'MXN' &&
    catalog.taxInclusive === true &&
    catalog.paymentsEnabled === false &&
    isFreeLimits(free?.limits) &&
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
  )) throw new Error('invalid plan catalog');

  return free.limits.maxActiveTrees === 1 ? REDUCED_PLAN_CATALOG : PREPAYMENT_PLAN_CATALOG;
}

/**
 * Keeps the frozen compatibility catalog separate from the strictly validated
 * individual offer. Public reads do not construct identity or product storage.
 */
@Injectable({ providedIn: 'root' })
export class PlanCatalogService {
  private readonly readPlans = inject(PUBLIC_PLAN_CATALOG);
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
        if (!isIndividualBillingCatalog(value) || value.catalogVersion !== CURRENT_INDIVIDUAL_BILLING_CATALOG_VERSION) throw new Error('invalid individual catalog');
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
    const request = this.readPlans()
      .then((value) => {
        const catalog = launchCatalog(value);
        // Canonicalize to the frozen client constant so extra wire fields and
        // mutable response objects never become application configuration.
        this.catalogSignal.set(catalog);
        this.loaded = true;
        return catalog;
      })
      .finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    this.inFlight = request;
    return request;
  }
}
