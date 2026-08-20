import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { type MarketingLang, MarketingLocaleService } from './marketing-locale.service';
import { MarketingTree } from './marketing-tree';

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

  protected setLanguage(lang: MarketingLang): void {
    this.locale.set(lang);
  }
}
