import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { AuthService } from '../../core/auth/auth.service';
import { PlanCatalogService } from '../../core/access/plan-catalog.service';
import { IndividualBillingService } from '../../core/api/individual-billing.service';
import { billingDocument } from '../../core/api/billing-document';
import { PrivacyService } from '../../core/privacy.service';
import type { BillingInterval, IndividualBillingState } from '../../core/api/contracts';
import { inputEl } from '../../shared/ui/dom';
import { AccountAccessSummary } from '../../shared/ui/account-access-summary';

@Component({
  selector: 'app-subscription-page',
  imports: [RouterLink, AccountAccessSummary],
  templateUrl: './subscription-page.html',
  styleUrl: './subscription-page.scss',
})
export class SubscriptionPage {
  protected readonly i18n = inject(I18nService);
  protected readonly auth = inject(AuthService);
  protected readonly catalog = inject(PlanCatalogService);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute, { optional: true });
  protected readonly billing = computed(() =>
    this.auth.user() ? this.injector.get(IndividualBillingService) : null,
  );
  private readonly privacy = computed(() =>
    this.auth.user() ? this.injector.get(PrivacyService) : null,
  );
  protected readonly accountAdmissionPending = computed(() =>
    Boolean(this.auth.user() && !this.privacy()?.status()),
  );
  protected readonly standardOwnAccount = computed(() => {
    const status = this.privacy()?.status();
    return this.auth.user()?.accountType === 'adult' && status?.scope === 'adult' && !status.privateOnly;
  });
  protected readonly eligibleBuyer = computed(
    () => this.standardOwnAccount() && this.privacy()?.status()?.accountAdmission === 'standard',
  );
  protected readonly interval = signal<BillingInterval>('month');
  protected readonly acceptsTerms = signal(false);
  protected readonly mexico = signal(false);
  protected readonly document = signal<Awaited<ReturnType<typeof billingDocument>> | null>(null);
  protected readonly returned =
    this.route?.snapshot.queryParamMap.get('return') === 'checkout' ||
    this.route?.snapshot.queryParamMap.get('return') === 'portal';
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly status = viewChild<ElementRef<HTMLElement>>('status');
  protected readonly termsMatch = computed(() => {
    const catalog = this.catalog.individualCatalog();
    const document = this.document();
    return Boolean(
      catalog &&
      document &&
      catalog.terms.version === document.version &&
      catalog.terms.hashes[document.language] === document.hash,
    );
  });
  protected readonly canCheckout = computed(
    () =>
      this.eligibleBuyer() &&
      Boolean(
        this.catalog.individualCatalog()?.purchasesEnabled && this.billing()?.canCheckout(),
      ) &&
      this.termsMatch() &&
      this.acceptsTerms() &&
      this.mexico(),
  );
  protected readonly errorText = computed(() => {
    const code = this.billing()?.error();
    if (!code) return '';
    switch (code) {
      case 'UNAUTHENTICATED':
        return this.i18n.t().billing.sessionError;
      case 'BILLING_TERMS_OUTDATED':
        return this.i18n.t().billing.termsChanged;
      case 'BILLING_BUYER_INELIGIBLE':
        return this.i18n.t().billing.adultOnly;
      case 'ACCOUNT_TERMS_REQUIRED':
        return this.i18n.t().privacy.accountTermsRequired;
      case 'BILLING_REVISION_CONFLICT':
      case 'BILLING_SUBSCRIPTION_EXISTS':
        return this.i18n.t().billing.conflict;
      default:
        return this.i18n.t().billing.error;
    }
  });

  constructor() {
    afterNextRender(() => this.heading()?.nativeElement.focus());
    effect(() => {
      const language = this.i18n.lang();
      this.document.set(null);
      this.acceptsTerms.set(false);
      void billingDocument(language)
        .then((document) => {
          if (this.i18n.lang() === language) this.document.set(document);
        })
        .catch(() => this.document.set(null));
    });
    effect(() => {
      const privacy = this.privacy();
      const language = this.i18n.lang();
      untracked(() => {
        if (privacy) void privacy.refresh(language).catch(() => undefined);
      });
    });
    effect(() => {
      this.auth.user()?.userId;
      this.acceptsTerms.set(false);
      this.mexico.set(false);
      const billing = this.billing();
      untracked(() => {
        void this.catalog.refreshIndividual();
        if (!billing) return;
        const returnKind = this.route?.snapshot.queryParamMap.get('return');
        if (returnKind === 'checkout' || returnKind === 'portal') void billing.confirm(returnKind);
        else
          void billing.refresh().then(() => {
            if (billing.pending()) void billing.confirm();
          });
      });
    });
    effect(() => {
      this.catalog.individualCatalog()?.terms.version;
      this.catalog.individualCatalog()?.terms.hashes.es;
      this.catalog.individualCatalog()?.terms.hashes.en;
      this.acceptsTerms.set(false);
    });
  }

  protected checked(event: Event): boolean {
    return (inputEl(event) as HTMLInputElement).checked;
  }
  protected price(interval: BillingInterval): string {
    const amount = this.catalog.individualCatalog()?.prices[interval].amountMinor;
    return amount === undefined
      ? ''
      : this.i18n.fill(
          interval === 'month' ? this.i18n.t().billing.monthly : this.i18n.t().billing.yearly,
          {
            amount: `$${new Intl.NumberFormat(this.i18n.lang() === 'es' ? 'es-MX' : 'en-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100)}`,
          },
        );
  }
  protected date(timestamp: number): string {
    return new Intl.DateTimeFormat(this.i18n.lang() === 'es' ? 'es-MX' : 'en-MX', {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(timestamp);
  }
  protected stateText(state: IndividualBillingState): string {
    const copy = this.i18n.t().billing;
    switch (state) {
      case 'none':
        return copy.none;
      case 'checkout_pending':
        return copy.pending;
      case 'active':
        return copy.active;
      case 'cancel_at_period_end':
        return copy.cancelAtEnd;
      case 'past_due':
        return copy.pastDue;
      case 'expired':
        return copy.expired;
      case 'payment_review':
        return copy.review;
      case 'closed':
        return copy.closed;
    }
  }
  protected async checkout(): Promise<void> {
    if (!this.canCheckout()) return;
    const catalog = this.catalog.individualCatalog()!;
    const document = this.document()!;
    await this.billing()!.checkout({
      interval: this.interval(),
      catalogVersion: catalog.catalogVersion,
      country: 'MX',
      termsAcceptance: {
        version: document.version,
        hash: document.hash,
        language: document.language,
        accepted: true,
      },
    });
    if (this.billing()?.error() === 'BILLING_TERMS_OUTDATED') {
      this.acceptsTerms.set(false);
      await this.catalog.refreshIndividual();
    }
    this.status()?.nativeElement.focus();
  }
  protected async portal(): Promise<void> {
    if (!this.standardOwnAccount()) return;
    await this.billing()?.portal();
    this.status()?.nativeElement.focus();
  }
  protected async recheck(): Promise<void> {
    await this.catalog.refreshIndividual();
    await this.privacy()
      ?.refresh(this.i18n.lang())
      .catch(() => undefined);
    const billing = this.billing();
    if (billing?.pending())
      await billing.confirm(
        this.route?.snapshot.queryParamMap.get('return') === 'portal' ? 'portal' : 'checkout',
      );
    else await billing?.refresh();
    this.status()?.nativeElement.focus();
  }
}
