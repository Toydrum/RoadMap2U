import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { PrivacyService } from '../../core/privacy.service';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ApiError, type PrivateAdolescentInvitation } from '../../core/api/contracts';
import { privacyDocument } from '../../core/api/privacy-document';
import { inputValue } from './dom';
import { ConfirmSheet } from './confirm-sheet';

/** Account/privacy metadata only; forest sync is an explicit output handled by Settings. */
@Component({
  selector: 'app-privacy-panel',
  imports: [RouterLink, ConfirmSheet],
  template: `
    <section class="card privacy-panel" aria-labelledby="privacy-title">
      <h2 id="privacy-title">{{ i18n.t().privacy.title }}</h2>
      <p>
        <a routerLink="/privacy">{{ i18n.t().privacy.readNotice }}</a> ·
        <a routerLink="/terms">{{ i18n.t().privacy.readTerms }}</a>
      </p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      @if (privacy.status(); as status) {
        @if (status.privateOnly) {
          <p>{{ i18n.t().privacy.privateOnly }}</p>
        }
        @if (status.guardianConsent === 'ended' && !status.adultDeclared) {
          <p>{{ i18n.t().privacy.majorityReview }}</p>
        }
        @if (status.scope === 'adolescent_private' && status.guardianConsent !== 'granted') {
          <p>{{ i18n.t().privacy.guardianWithdrawn }}</p>
        }
        @if (status.scope === 'unsupported') {
          <p>{{ i18n.t().privacy.rightsBody }}</p>
        }
        @if (needsAdmission() && status.scope !== 'unsupported') {
          <form (submit)="$event.preventDefault(); admit()">
            <p>{{ i18n.t().privacy.adultBody }}</p>
            <fieldset>
              <legend>{{ i18n.t().privacy.ageLabel }}</legend>
              @if (status.scope !== 'adolescent_private') {
                <label class="choice"
                  ><input
                    type="radio"
                    name="privacy-age"
                    value="adult"
                    [checked]="age() === 'adult'"
                    (change)="chooseAge('adult')"
                  />{{ document()?.declaration?.adult }}</label
                >
              }
              @if (!status.privateOnly || status.scope === 'adolescent_private') {
                <label class="choice"
                  ><input
                    type="radio"
                    name="privacy-age"
                    value="adolescent"
                    [checked]="age() === 'adolescent'"
                    (change)="chooseAge('adolescent')"
                  />{{ i18n.t().privacy.adolescentChoice }}</label
                >
              }
            </fieldset>
            @if (age() === 'adolescent') {
              <p>{{ document()?.adolescent?.explanation }}</p>
              <label class="field"
                ><span>{{ i18n.t().privacy.invitationLabel }}</span
                ><input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  maxlength="64"
                  [value]="invitationId()"
                  (input)="invitationId.set(inputValue($event).trim())"
              /></label>
              <label class="choice"
                ><input
                  type="checkbox"
                  [checked]="understood()"
                  (change)="understood.set($any($event.target).checked)"
                />{{ document()?.adolescent?.understanding }}</label
              >
              <p>{{ i18n.t().privacy.pendingVerification }}</p>
            }
            <details>
              <summary>{{ i18n.t().privacy.readTerms }}</summary>
              @for (section of document()?.terms?.sections ?? []; track section.title) {
                <h3>{{ section.title }}</h3>
                @for (paragraph of section.paragraphs; track $index) {
                  <p>{{ paragraph }}</p>
                }
              }
            </details>
            <label class="choice"
              ><input
                type="checkbox"
                [checked]="terms()"
                (change)="terms.set($any($event.target).checked)"
              />{{ document()?.declaration?.terms }}</label
            >
            <button
              type="submit"
              class="btn btn-primary"
              [disabled]="
                busy() ||
                !document() ||
                !terms() ||
                !age() ||
                (age() === 'adolescent' && (!understood() || !invitationId()))
              "
            >
              {{ i18n.t().privacy.adultConfirm }}
            </button>
          </form>
        }
        @if (showCloud()) {
          <p role="status">{{ consentText() }}</p>
          @if (status.scope === 'adolescent_private') {
            <p class="responsible-premium-status" role="status">
              {{
                status.cloudCoverage?.state === 'active'
                  ? i18n.t().privacy.responsiblePremiumActive
                  : i18n.t().privacy.responsiblePremiumRequired
              }}
            </p>
          }
          @if (status.erasure === 'requested' || status.erasure === 'purging') {
            <p>{{ i18n.t().privacy.erasurePending }}</p>
          }
          @if (status.erasure === 'blocked') {
            <p>{{ i18n.t().privacy.erasureBlocked }}</p>
          }
          @if (status.erasure === 'completed') {
            <p>{{ i18n.t().privacy.erasureComplete }}</p>
          }
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="
                busy() ||
                needsAdmission() ||
                !['none', 'completed'].includes(status.erasure) ||
                (status.scope === 'adolescent_private' && status.cloudCoverage?.state !== 'active')
              "
              (click)="openCloud()"
            >
              {{ i18n.t().nube.connectCta }}
            </button>
            <button
              type="button"
              class="btn btn-soft"
              [disabled]="busy()"
              (click)="sheet.set('revoke')"
            >
              {{ i18n.t().privacy.revoke }}
            </button>
            <button type="button" class="btn btn-soft" [disabled]="busy()" (click)="exportOwn()">
              {{ i18n.t().privacy.export }}
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              [disabled]="busy()"
              (click)="sheet.set('erase')"
            >
              {{ i18n.t().privacy.erase }}
            </button>
          </div>
          <p>{{ i18n.t().privacy.rightsBody }}</p>
        }
        @if (status.scope === 'adult' && status.adultDeclared) {
          <details>
            <summary>{{ i18n.t().privacy.guardianTitle }}</summary>
            <p>{{ document()?.adolescent?.explanation }}</p>
            <form (submit)="$event.preventDefault(); invite()">
              <p>{{ i18n.t().privacy.automaticAuthorization }}</p>
              <label class="field"
                ><span>{{ i18n.t().privacy.guardianName }}</span>
                <input
                  type="text"
                  name="guardian-name"
                  autocomplete="name"
                  maxlength="160"
                  [value]="guardianName()"
                  (input)="guardianName.set(inputValue($event)); resetGuardianChoices()"
                />
              </label>
              <label class="field"
                ><span>{{ i18n.t().privacy.guardianRelationship }}</span>
                <select
                  name="guardian-relationship"
                  [value]="guardianRelationship()"
                  (change)="chooseGuardianRelationship(inputValue($event))"
                >
                  <option value="">{{ i18n.t().privacy.chooseRelationship }}</option>
                  <option value="parent">{{ i18n.t().privacy.parentRelationship }}</option>
                  <option value="legal_guardian">
                    {{ i18n.t().privacy.legalGuardianRelationship }}
                  </option>
                </select>
              </label>
              <label class="field"
                ><span>{{ i18n.t().privacy.recipientUsername }}</span
                ><input
                  type="text"
                  autocapitalize="none"
                  autocomplete="off"
                  [value]="recipient()"
                  (input)="
                    recipient.set(inputValue($event).trim().toLowerCase()); resetGuardianChoices()
                  "
              /></label>
              <label class="field"
                ><span>{{ i18n.t().privacy.majorityDate }}</span
                ><input
                  type="date"
                  [value]="majorityAt()"
                  (input)="majorityAt.set(inputValue($event)); resetGuardianChoices()"
              /></label>
              <label class="choice"
                ><input
                  type="checkbox"
                  [checked]="represents()"
                  (change)="represents.set($any($event.target).checked)"
                />{{ document()?.adolescent?.representation }}</label
              >
              <label class="choice"
                ><input
                  type="checkbox"
                  [checked]="guardianAccepts()"
                  (change)="guardianAccepts.set($any($event.target).checked)"
                />{{ document()?.adolescent?.authorization }}</label
              >
              <button
                type="submit"
                class="btn btn-soft"
                [disabled]="
                  busy() ||
                  !represents() ||
                  !guardianAccepts() ||
                  !recipient() ||
                  !majorityAt() ||
                  !guardianName().trim() ||
                  !guardianRelationship()
                "
              >
                {{ i18n.t().privacy.requestInvitation }}
              </button>
            </form>
            <button
              type="button"
              class="btn btn-soft"
              [disabled]="busy()"
              (click)="loadInvitations()"
            >
              {{ i18n.t().privacy.manageInvitations }}
            </button>
            @for (item of invitations(); track item.invitationId) {
              <article class="invitation">
                <h3>&#64;{{ item.recipientUsername }}</h3>
                <p>{{ i18n.t().privacy.invitationStates[item.state] }}</p>
                @if (item.state === 'pending_verification') {
                  <p>{{ i18n.t().privacy.pendingVerification }}</p>
                }
                <p class="invitation-id">{{ item.invitationId }}</p>
                @if (
                  item.adolescentId &&
                  item.consentRevision !== undefined &&
                  item.guardianConsent !== 'ended'
                ) {
                  <button
                    type="button"
                    class="btn btn-soft"
                    [disabled]="busy()"
                    (click)="guardian(item, false)"
                  >
                    {{ i18n.t().privacy.guardianRevoke }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-soft"
                    [disabled]="busy() || !represents() || !guardianAccepts()"
                    (click)="guardian(item, true)"
                  >
                    {{ i18n.t().privacy.guardianGrant }}
                  </button>
                }
              </article>
            }
          </details>
        }
      } @else {
        <p>{{ i18n.t().privacy.loading }}</p>
      }
      <button type="button" class="btn btn-ghost" [disabled]="busy()" (click)="refresh()">
        {{ i18n.t().privacy.refresh }}
      </button>
    </section>
    @if (sheet() === 'cloud') {
      <app-confirm-sheet
        icon="☁️"
        [title]="i18n.t().privacy.cloudTitle"
        [body]="document()?.cloud?.body ?? ''"
        [confirmLabel]="i18n.t().privacy.authorize"
        [cancelLabel]="i18n.t().privacy.stayLocal"
        [confirmDisabled]="busy() || !cloudAccepts() || !document()"
        (cancelled)="closeSheet()"
        (confirmed)="grantCloud()"
      >
        <p>{{ document()?.cloud?.sensitive }}</p>
        <details>
          <summary>{{ i18n.t().privacy.readNotice }}</summary>
          @for (section of document()?.notice?.sections ?? []; track section.title) {
            <h3>{{ section.title }}</h3>
            @for (paragraph of section.paragraphs; track $index) {
              <p>{{ paragraph }}</p>
            }
          }
        </details>
        <label class="choice"
          ><input
            type="checkbox"
            [checked]="cloudAccepts()"
            (change)="cloudAccepts.set($any($event.target).checked)"
          />{{ document()?.cloud?.authorization }}</label
        >
      </app-confirm-sheet>
    }
    @if (sheet() === 'revoke') {
      <app-confirm-sheet
        icon="🌿"
        [title]="i18n.t().privacy.revokeTitle"
        [body]="i18n.t().privacy.revokeBody"
        [confirmLabel]="i18n.t().privacy.revokeConfirm"
        [confirmDisabled]="busy()"
        (cancelled)="closeSheet()"
        (confirmed)="withdraw(false)"
      />
    }
    @if (sheet() === 'erase') {
      <app-confirm-sheet
        icon="🌿"
        [title]="i18n.t().privacy.eraseTitle"
        [body]="i18n.t().privacy.eraseBody"
        [confirmLabel]="i18n.t().privacy.eraseConfirm"
        [confirmDisabled]="busy()"
        (cancelled)="closeSheet()"
        (confirmed)="withdraw(true)"
      />
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .privacy-panel {
      padding: 1.25rem;
      text-align: left;
    }
    h2 {
      margin-top: 0;
    }
    h3 {
      font-size: 1rem;
    }
    p {
      line-height: 1.6;
    }
    fieldset {
      border: 1px solid var(--line, #d7dfd1);
      border-radius: 0.65rem;
      padding: 0.8rem;
      margin-block: 1rem;
    }
    .choice {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      text-align: left;
      margin-block: 1rem;
      line-height: 1.55;
    }
    .choice input {
      flex: none;
      margin-top: 0.3rem;
      width: 1.1rem;
      height: 1.1rem;
    }
    .field {
      display: grid;
      gap: 0.4rem;
      margin-block: 0.8rem;
    }
    .field input,
    .field select {
      width: 100%;
      box-sizing: border-box;
      min-height: 2.75rem;
      font: inherit;
      padding: 0.65rem;
      border-radius: 0.5rem;
      border: 1px solid var(--line, #d7dfd1);
      background: var(--surface, #fff);
      color: inherit;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
    }
    details {
      margin-block: 1rem;
    }
    summary {
      cursor: pointer;
      padding-block: 0.5rem;
    }
    .invitation {
      border-top: 1px solid var(--line, #d7dfd1);
      padding-top: 0.8rem;
    }
    .invitation-id {
      overflow-wrap: anywhere;
      font-size: 0.82rem;
    }
    .btn {
      white-space: normal;
    }
    input:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--accent, #496b3c);
      outline-offset: 3px;
    }
  `,
})
export class PrivacyPanel {
  protected readonly privacy = inject(PrivacyService);
  protected readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthService);
  readonly showCloud = input(false);
  readonly admitted = output<void>();
  readonly cloudAuthorized = output<void>();
  protected readonly inputValue = inputValue;
  protected readonly document = signal<
    Awaited<ReturnType<typeof privacyDocument>>['document'] | null
  >(null);
  protected readonly age = signal<'adult' | 'adolescent' | null>(null);
  protected readonly terms = signal(false);
  protected readonly understood = signal(false);
  protected readonly invitationId = signal('');
  protected readonly recipient = signal('');
  protected readonly guardianName = signal('');
  protected readonly guardianRelationship = signal<'parent' | 'legal_guardian' | ''>('');
  protected readonly majorityAt = signal('');
  protected readonly represents = signal(false);
  protected readonly guardianAccepts = signal(false);
  protected readonly cloudAccepts = signal(false);
  protected readonly invitations = signal<PrivateAdolescentInvitation[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly sheet = signal<'cloud' | 'revoke' | 'erase' | null>(null);
  protected readonly needsAdmission = computed(() => {
    const state = this.privacy.status();
    return (
      !!state &&
      (state.scope === 'adult'
        ? !state.adultDeclared
        : state.scope !== 'adolescent_private' || !state.adolescentUnderstood)
    );
  });
  private disposed = false;
  constructor() {
    inject(DestroyRef).onDestroy(() => (this.disposed = true));
    effect(() => {
      const owner = this.auth.user();
      const language = this.i18n.lang();
      this.closeSheet();
      this.terms.set(false);
      this.understood.set(false);
      this.represents.set(false);
      this.guardianAccepts.set(false);
      this.guardianName.set('');
      this.guardianRelationship.set('');
      this.recipient.set('');
      this.majorityAt.set('');
      this.age.set(null);
      this.document.set(null);
      this.invitations.set([]);
      void privacyDocument(language).then((value) => {
        if (!this.disposed && this.i18n.lang() === language) this.document.set(value.document);
      });
      if (owner && !this.auth.sessionStale()) untracked(() => void this.refresh());
    });
  }
  protected async run(operation: () => Promise<unknown>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await operation();
    } catch (error) {
      this.error.set(
        error instanceof ApiError
          ? this.i18n.t().familia.errors[error.code]
          : this.i18n.t().privacy.saveError,
      );
    } finally {
      this.busy.set(false);
    }
  }
  protected refresh() {
    return this.run(async () => {
      const status = await this.privacy.refresh(this.i18n.lang());
      if (status.scope === 'adolescent_private') this.age.set('adolescent');
      if (status.invitationId) this.invitationId.set(status.invitationId);
    });
  }
  protected admit() {
    return this.run(async () => {
      if (this.age() === 'adult')
        await this.privacy.declareAdult(this.i18n.lang(), true, this.terms());
      else if (this.age() === 'adolescent')
        await this.privacy.acceptAdolescent(
          this.i18n.lang(),
          this.invitationId(),
          this.terms(),
          this.understood(),
        );
      else throw new ApiError('VALIDATION');
      this.terms.set(false);
      this.understood.set(false);
      this.notice.set(this.i18n.t().privacy.declarationDone);
      this.admitted.emit();
    });
  }
  protected consentText() {
    switch (this.privacy.status()?.cloudConsent) {
      case 'granted':
        return this.i18n.t().privacy.granted;
      case 'revoked':
        return this.i18n.t().privacy.revoked;
      case 'version_review_required':
        return this.i18n.t().privacy.reviewRequired;
      default:
        return this.i18n.t().privacy.absent;
    }
  }
  protected openCloud() {
    this.cloudAccepts.set(false);
    this.sheet.set('cloud');
  }
  protected chooseAge(age: 'adult' | 'adolescent') {
    this.age.set(age);
    this.terms.set(false);
    this.understood.set(false);
  }
  protected closeSheet() {
    this.sheet.set(null);
    this.cloudAccepts.set(false);
  }
  protected grantCloud() {
    return this.run(async () => {
      const next = await this.privacy.grantCloud(this.i18n.lang(), this.cloudAccepts());
      if (!next.canUseCloud) throw new ApiError('CLOUD_CONSENT_REQUIRED');
      this.closeSheet();
      this.cloudAuthorized.emit();
    });
  }
  protected withdraw(erase: boolean) {
    return this.run(async () => {
      if (erase) await this.privacy.eraseCloud(this.i18n.lang());
      else await this.privacy.revokeCloud(this.i18n.lang());
      this.closeSheet();
    });
  }
  protected exportOwn() {
    return this.run(async () => {
      const exported = await this.privacy.exportOwn();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `RoadMap2U-privacy-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.notice.set(this.i18n.t().privacy.exportDone);
    });
  }
  protected loadInvitations() {
    return this.run(async () => this.invitations.set(await this.privacy.invitations()));
  }
  protected invite() {
    return this.run(async () => {
      await this.privacy.invite(
        this.i18n.lang(),
        this.recipient(),
        this.majorityAt(),
        this.guardianName(),
        this.guardianRelationship(),
        this.represents(),
        this.guardianAccepts(),
      );
      this.invitations.set(await this.privacy.invitations());
      this.represents.set(false);
      this.guardianAccepts.set(false);
    });
  }
  protected resetGuardianChoices() {
    this.represents.set(false);
    this.guardianAccepts.set(false);
  }
  protected chooseGuardianRelationship(value: string) {
    this.guardianRelationship.set(value === 'parent' || value === 'legal_guardian' ? value : '');
    this.resetGuardianChoices();
  }
  protected guardian(item: PrivateAdolescentInvitation, grant: boolean) {
    return this.run(async () => {
      await this.privacy.guardian(
        this.i18n.lang(),
        item,
        grant,
        this.represents(),
        this.guardianAccepts(),
      );
      this.invitations.set(await this.privacy.invitations());
      this.represents.set(false);
      this.guardianAccepts.set(false);
      this.notice.set(this.i18n.t().privacy.guardianSaved);
    });
  }
}
