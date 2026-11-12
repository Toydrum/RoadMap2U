import { Injectable, computed, effect, signal } from '@angular/core';
import { EN } from '../../core/i18n/en';
import { ES } from '../../core/i18n/es';

export type MarketingLang = 'es' | 'en';

/**
 * Ephemeral locale for the public surface. It deliberately does not use the
 * product I18nService because that service reads persistent app settings.
 * Public routes start in Spanish unless the incoming link specifies a language.
 */
@Injectable()
export class MarketingLocaleService {
  readonly lang = signal<MarketingLang>('es');
  readonly copy = computed(() => (this.lang() === 'en' ? EN : ES));

  constructor() {
    effect(() => {
      document.documentElement.lang = this.lang();
    });
  }

  set(lang: MarketingLang): void {
    this.lang.set(lang);
  }
}
