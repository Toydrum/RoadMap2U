import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { commonAccountDocument } from '../../core/api/privacy-document';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { PrivacyService } from '../../core/privacy.service';
import { PremiumCloudIntentService } from '../../core/sync/premium-cloud-intent';

@Component({
  selector: 'app-premium-cloud-choice',
  imports: [RouterLink],
  template: `
    <fieldset [disabled]="disabled()">
      <legend>{{ i18n.t().premiumCloud.title }}</legend>
      @if (document(); as doc) {
        <p>{{ doc.document.cloud.body }}</p>
        <p>{{ doc.document.cloud.sensitive }}</p>
        <a routerLink="/privacy" [queryParams]="{ lang: doc.document.language }">
          {{ i18n.t().privacy.readNotice }}
        </a>
        <p><label>
          <input type="checkbox" [checked]="selected()" (change)="toggle($event)" />
          {{ alreadyAuthorized() ? i18n.t().premiumCloud.useAuthorization : doc.document.cloud.authorization }}
        </label></p>
        @if (selected()) {
          <p><label>
            <input type="checkbox" [checked]="allowUpload()" (change)="allowUpload.set(checked($event))" />
            {{ i18n.fill(i18n.t().premiumCloud.device, { account: username() }) }}
          </label></p>
        }
      }
      @if (failed()) { <p role="status">{{ i18n.t().premiumCloud.local }}</p> }
    </fieldset>
  `,
})
export class PremiumCloudChoice {
  readonly disabled = input(false);
  private readonly auth = inject(AuthService);
  private readonly privacy = inject(PrivacyService);
  protected readonly i18n = inject(I18nService);
  protected readonly username = computed(() => this.auth.user()?.username ?? '');
  protected readonly alreadyAuthorized = computed(
    () => this.privacy.status()?.canUseCloud === true && !this.privacy.cloudBlocked(),
  );
  protected readonly document = signal<Awaited<ReturnType<typeof commonAccountDocument>> | null>(null);
  protected readonly selected = signal(false);
  readonly wantsCloud = this.selected.asReadonly();
  protected readonly allowUpload = signal(false);
  protected readonly failed = signal(false);
  private readonly acceptedExisting = signal(false);

  constructor() {
    effect(() => {
      const language = this.i18n.lang();
      const owner = this.auth.user();
      this.document.set(null);
      this.selected.set(false);
      this.allowUpload.set(false);
      this.failed.set(false);
      if (owner) void commonAccountDocument(language).then((document) => {
        if (this.auth.user() === owner && this.i18n.lang() === language)
          this.document.set(document);
      }).catch(() => undefined);
    });
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected toggle(event: Event): void {
    this.selected.set(this.checked(event));
    this.acceptedExisting.set(this.alreadyAuthorized());
    this.allowUpload.set(false);
    this.failed.set(false);
  }

  async prepare(service: PremiumCloudIntentService) {
    if (!this.selected()) return null;
    const document = this.document();
    if (!document) return null;
    const choice = await service.choose(
      document.document.language,
      document.hash,
      this.acceptedExisting(),
      this.allowUpload(),
    ).catch(() => null);
    if (!choice) this.failed.set(true);
    return choice;
  }
}
