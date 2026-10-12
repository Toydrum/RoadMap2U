import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type MarketingLang, MarketingLocaleService } from './marketing-locale.service';
import { MarketingTree } from './marketing-tree';
import { PlanCatalogService } from '../../core/access/plan-catalog.service';

@Component({
  selector: 'app-landing',
  imports: [RouterLink, MarketingTree],
  providers: [MarketingLocaleService],
  templateUrl: './landing.html',
  styleUrls: ['./landing.scss', './landing-responsive.scss'],
})
export class LandingPage {
  protected readonly locale = inject(MarketingLocaleService);
  protected readonly copy = this.locale.copy;
  protected readonly lang = this.locale.lang;
  protected readonly plans = inject(PlanCatalogService);

  constructor() {
    void this.plans.loadIndividual();
  }

  protected price(interval: 'month' | 'year'): string {
    const catalog = this.plans.individualCatalog();
    if (!catalog) return '';
    const amount = `$${catalog.prices[interval].amountMinor / 100}`;
    return (
      interval === 'month' ? this.copy().billing.monthly : this.copy().billing.yearly
    ).replace('{amount}', amount);
  }

  protected setLanguage(lang: MarketingLang): void {
    this.locale.set(lang);
  }
}
