import { Component, computed, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { PHONE_INSTALL_COPY } from '../../core/i18n/phone-install-copy';

// The shared dictionaries are pinned by the deployed backend contract.
const RETIRED_TEA_SENTENCES = [
  ' También puedes preparar un té: dos o tres frutas saboreadas sorbo a sorbo, sin dejar registro.',
  ' You can also brew a tea: two or three fruits savored sip by sip, leaving no record.',
];

/** In-app guide: a short, calm walk through the whole app. */
@Component({
  selector: 'app-guide',
  templateUrl: './guide.html',
  styleUrl: './guide.scss',
})
export class GuidePage {
  protected readonly i18n = inject(I18nService);
  private readonly location = inject(Location);
  private readonly router = inject(Router);

  protected readonly sections = computed(() => {
    const install = PHONE_INSTALL_COPY[this.i18n.lang()];
    const sections = this.i18n.t().guide.sections.map((section) =>
      section.icon === '🫙'
        ? {
            ...section,
            body: RETIRED_TEA_SENTENCES.reduce((body, sentence) => body.replace(sentence, ''), section.body),
          }
        : section,
    );
    return [{ icon: '📱', title: install.title, body: install.guide }, ...sections];
  });

  protected goBack(): void {
    if (history.length > 1) {
      this.location.back();
    } else {
      void this.router.navigate(['/forest']);
    }
  }
}
