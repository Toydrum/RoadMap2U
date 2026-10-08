import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyPanel } from './privacy-panel';
import { API_CLIENT } from '../../core/api/api-client';
import { ADULT_PRIVACY_VERSIONS } from '../../core/api/contracts';
import { AuthService } from '../../core/auth/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ES } from '../../core/i18n/es';
import { privacyDocument } from '../../core/api/privacy-document';
const change = vi.fn();
beforeEach(async () => {
  change.mockReset();
  const hash = (await privacyDocument('es')).hash;
  TestBed.configureTestingModule({
    imports: [PrivacyPanel],
    providers: [
      provideRouter([]),
      {
        provide: API_CLIENT,
        useValue: {
          getPrivacyStatus: async () => ({
            userId: 'owner',
            scope: 'adult',
            enforcement: 'enforce',
            revision: 1,
            adultDeclared: true,
            cloudConsent: 'absent',
            canUseCloud: false,
            erasure: 'none',
            versions: ADULT_PRIVACY_VERSIONS,
            documentHash: hash,
            updatedAt: 1,
          }),
          changePrivacyConsent: change,
        },
      },
      {
        provide: AuthService,
        useValue: { user: signal({ userId: 'owner' }), sessionStale: signal(false) },
      },
      { provide: I18nService, useValue: { t: signal(ES), lang: signal('es') } },
    ],
  });
});
afterEach(() => TestBed.resetTestingModule());
describe('privacy cloud sheet', () => {
  it('requires declared name and relationship with unchecked decisions before issuing an invitation', async () => {
    const fixture = TestBed.createComponent(PrivacyPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect((fixture.componentInstance as any).privacy.status()).not.toBeNull(),
    );
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('details form') as HTMLFormElement;
    const name = form.querySelector('input[name="guardian-name"]') as HTMLInputElement;
    const relationship = form.querySelector(
      'select[name="guardian-relationship"]',
    ) as HTMLSelectElement;
    expect(name).not.toBeNull();
    expect(relationship).not.toBeNull();
    expect(relationship.value).toBe('');
    expect(form.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(0);
    expect((form.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    expect(form.textContent).toContain('Premium');
  });
  it('keeps export available and explains the missing responsible-adult Premium before connecting', async () => {
    const fixture = TestBed.createComponent(PrivacyPanel);
    fixture.componentRef.setInput('showCloud', true);
    fixture.detectChanges();
    await fixture.whenStable();
    const privacy = (fixture.componentInstance as any).privacy;
    await vi.waitFor(() => expect(privacy.status()).not.toBeNull());
    vi.spyOn(TestBed.inject(API_CLIENT), 'getPrivacyStatus').mockResolvedValue({
      ...privacy.status(),
      scope: 'adolescent_private',
      adultDeclared: false,
      privateOnly: true,
      adolescentUnderstood: true,
      guardianConsent: 'granted',
      cloudConsent: 'granted',
      canUseCloud: false,
      cloudCoverage: { kind: 'responsible_premium', state: 'unavailable', validUntil: null },
    });
    await privacy.refresh('es');
    fixture.detectChanges();
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
    expect(
      buttons.find((button) => button.textContent?.includes(ES.nube.connectCta))!.disabled,
    ).toBe(true);
    expect(
      buttons.find((button) => button.textContent?.includes(ES.privacy.export))!.disabled,
    ).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Premium');
    expect(change).not.toHaveBeenCalled();
  });
  it('opens with an unchecked acceptance, traps focus and Escape makes no consent write', async () => {
    const fixture = TestBed.createComponent(PrivacyPanel);
    fixture.componentRef.setInput('showCloud', true);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect((fixture.componentInstance as any).privacy.status()).not.toBeNull(),
    );
    fixture.detectChanges();
    const button = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((button) => button.textContent?.includes(ES.nube.connectCta))!;
    button.focus();
    button.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect((dialog.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(
      false,
    );
    const confirm = Array.from(dialog.querySelectorAll('button')).find((button) =>
      button.textContent?.includes(ES.privacy.authorize),
    )!;
    expect(confirm.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(change).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
});
