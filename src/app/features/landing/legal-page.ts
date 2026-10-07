import { Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink, RouterLinkActive } from '@angular/router';
import { type MarketingLang, MarketingLocaleService } from './marketing-locale.service';

/** Public review documents share the landing's transient locale only. */
@Component({
  selector: 'app-legal-page',
  imports: [RouterLink, RouterLinkActive],
  providers: [MarketingLocaleService],
  templateUrl: './legal-page.html',
  styleUrl: './legal-page.scss',
})
export class LegalPage {
  protected readonly locale = inject(MarketingLocaleService);
  protected readonly copy = this.locale.copy;
  protected readonly lang = this.locale.lang;
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private readonly kind = inject(ActivatedRoute).snapshot.data['legalDocument'];
  private readonly title = inject(Title);
  protected readonly document = computed(() => {
    switch (this.kind) {
      case 'privacy':
        return this.copy().legal.privacy;
      case 'terms':
        return this.copy().legal.terms;
      case 'support':
        return this.copy().legal.support;
      default:
        throw new Error('Unknown public legal document');
    }
  });

  constructor() {
    effect(() => this.title.setTitle(this.copy().app.name + ' — ' + this.document().title));
  }

  protected setLanguage(lang: MarketingLang): void {
    this.locale.set(lang);
  }

  protected focusMain(): void {
    this.main().nativeElement.focus();
  }
}
