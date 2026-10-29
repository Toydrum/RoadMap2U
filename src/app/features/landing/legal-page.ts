import { Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { type MarketingLang, MarketingLocaleService } from './marketing-locale.service';
import { CURRENT_SUBSCRIPTION_TERMS_VERSION, subscriptionTermsDocument } from '../../core/api/subscription-terms-documents';

/** Public review documents share the landing's transient locale only. */
@Component({
  selector: 'app-legal-page',
  imports: [RouterLink, RouterLinkActive],
  providers: [MarketingLocaleService],
  templateUrl: './legal-page.html',
  styleUrl: './legal-page.scss',
})
export class LegalPage {
  protected readonly currentDocumentMatch = { paths: 'exact', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' } as const;
  protected readonly locale = inject(MarketingLocaleService);
  protected readonly copy = this.locale.copy;
  protected readonly lang = this.locale.lang;
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  private readonly kind = this.route.snapshot.data['legalDocument'];
  private readonly title = inject(Title);
  private readonly subscription = computed(() => {
    const version = this.query().get('version');
    // Only the exact retained documents are readable; unknown contracts never
    // fall through to a different accepted text.
    if (version === null || version === CURRENT_SUBSCRIPTION_TERMS_VERSION)
      return subscriptionTermsDocument(this.lang());
    if (version === 'individual-subscription-2026-10-28-v1')
      return subscriptionTermsDocument(this.lang(), version);
    return null;
  });
  protected readonly unavailable = computed(() => this.kind === 'subscription' && !this.subscription());
  protected readonly subscriptionQuery = computed(() => ({
    lang: this.lang(),
    ...(this.kind === 'subscription' && this.query().has('version') ? { version: this.query().get('version') } : {}),
  }));
  protected readonly document = computed(() => {
    switch (this.kind) {
      case 'privacy':
        return this.copy().legal.privacy;
      case 'terms':
        return this.copy().legal.terms;
      case 'support':
        return this.copy().legal.support;
      case 'subscription':
        const selected = this.subscription();
        return {
          title: this.copy().billing.termsTitle,
          intro: selected
            ? selected.version === CURRENT_SUBSCRIPTION_TERMS_VERSION ? this.copy().billing.termsDraft : selected.version
            : this.copy().billing.termsUnavailable,
          sections: selected ? [
            {
              title: selected.version,
              paragraphs: [selected.text],
            },
          ] : [],
        };
      default:
        throw new Error('Unknown public legal document');
    }
  });

  constructor() {
    effect(() => {
      const requestedLanguage = this.query().get('lang');
      if (requestedLanguage === 'es' || requestedLanguage === 'en') this.locale.set(requestedLanguage);
    });
    effect(() => this.title.setTitle(this.copy().app.name + ' — ' + this.document().title));
  }

  protected setLanguage(lang: MarketingLang): void {
    this.locale.set(lang);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { lang }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected focusMain(): void {
    this.main().nativeElement.focus();
  }
}
