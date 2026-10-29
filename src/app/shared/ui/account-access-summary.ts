import { Component, computed, effect, inject, untracked } from '@angular/core';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import type { AccessSource } from '../../core/api/contracts';
import { I18nService } from '../../core/i18n/i18n.service';

/** One presentation of the validated access lease; billing remains a separate source. */
@Component({
  selector: 'app-account-access-summary',
  template: `
    <div
      class="access-summary"
      role="status"
      aria-live="polite"
      [attr.aria-busy]="access.loading()"
    >
      @if (access.loading()) {
        <p>{{ i18n.t().accountStatus.loading }}</p>
      } @else if (unconfirmed()) {
        <p>{{ i18n.t().accountStatus.unavailable }}</p>
        <button type="button" class="btn btn-soft access-retry" (click)="refresh()">
          {{ i18n.t().billing.refresh }}
        </button>
      } @else {
        <p class="access-plan">
          <strong>{{
            access.access().effectivePlanKey === 'premium'
              ? i18n.t().accountStatus.premium
              : i18n.t().accountStatus.free
          }}</strong>
        </p>
        @for (source of access.access().activeSources; track source.sourceId) {
          @if (source.kind !== 'default') {
            <p class="access-source">{{ sourceText(source) }}</p>
          }
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    p {
      margin-block: 0.5rem;
      overflow-wrap: anywhere;
    }
    .access-source {
      color: var(--text-faint);
    }
  `,
})
export class AccountAccessSummary {
  protected readonly access = inject(AccessService);
  protected readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  protected readonly unconfirmed = computed(
    () => this.access.leaseState() !== 'valid' || Boolean(this.access.lastError()),
  );

  constructor() {
    effect(() => {
      if (this.auth.user()) untracked(() => void this.access.start());
    });
  }

  protected refresh(): void {
    void this.access.refresh();
  }

  protected sourceText(source: AccessSource): string {
    const copy = this.i18n.t().accountStatus;
    if (source.kind === 'subscription') return copy.subscription;
    if (source.validUntil === null) return copy.sponsoredPermanent;
    const date = new Intl.DateTimeFormat(this.i18n.lang() === 'es' ? 'es-MX' : 'en-MX', {
      dateStyle: 'long',
    }).format(source.validUntil);
    return this.i18n.fill(copy.sponsoredUntil, { date });
  }
}
