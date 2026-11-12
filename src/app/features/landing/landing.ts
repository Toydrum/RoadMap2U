import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Meta, Title } from '@angular/platform-browser';
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
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');

  constructor() {
    void this.plans.loadIndividual();
    void this.plans.load().catch(() => undefined);
    effect(() => {
      this.title.setTitle(this.copy().landing.seo.title);
      this.meta.updateTag({ name: 'description', content: this.copy().landing.seo.description });
    });
  }

  protected quotaText(message: string): string | null {
    if (!message.includes('{trees}') && !message.includes('{branches}')) return message;
    const limits = this.plans.confirmedCatalog()?.plans.free.limits;
    if (!limits) return null;
    const trees = this.copy().landing.plans.free.activeTrees;
    const treeCount = limits.maxActiveTrees === 1
      ? trees.one
      : trees.many.replace('{count}', String(limits.maxActiveTrees));
    return message
      .replace('{trees}', treeCount)
      .replace('{branches}', String(limits.maxVisibleBranchesPerTree));
  }

  protected price(interval: 'month' | 'year'): string {
    const catalog = this.plans.individualCatalog();
    if (!catalog) return '';
    const amount = `$${new Intl.NumberFormat(this.lang() === 'es' ? 'es-MX' : 'en-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(catalog.prices[interval].amountMinor / 100)}`;
    return (
      interval === 'month' ? this.copy().billing.monthly : this.copy().billing.yearly
    ).replace('{amount}', amount);
  }

  protected setLanguage(lang: MarketingLang): void {
    this.locale.set(lang);
  }

  protected focusMain(): void {
    this.main().nativeElement.focus();
  }
}
