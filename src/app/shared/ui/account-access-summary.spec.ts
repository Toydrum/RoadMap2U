import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from '../../core/access/access.service';
import { AuthService } from '../../core/auth/auth.service';
import { createFreeAccessSummary } from '../../core/api/contracts';
import { ES } from '../../core/i18n/es';
import { EN } from '../../core/i18n/en';
import { I18nService } from '../../core/i18n/i18n.service';
import { AccountAccessSummary } from './account-access-summary';

describe('account access presentation', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function render() {
    const access = {
      access: signal(createFreeAccessSummary()),
      leaseState: signal<'valid' | 'fallback'>('valid'),
      loading: signal(false),
      lastError: signal<string | null>(null),
      start: vi.fn(async () => undefined),
      refresh: vi.fn(async () => createFreeAccessSummary()),
    };
    const lang = signal<'es' | 'en'>('es');
    TestBed.configureTestingModule({
      imports: [AccountAccessSummary],
      providers: [
        { provide: AccessService, useValue: access },
        { provide: AuthService, useValue: { user: signal({ userId: 'demo' }) } },
        {
          provide: I18nService,
          useValue: {
            lang,
            t: () => (lang() === 'es' ? ES : EN),
            fill: (text: string, values: Record<string, string>) =>
              text.replace(/\{(\w+)\}/g, (_, key) => values[key]),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(AccountAccessSummary);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement, access, lang };
  }

  it('shows confirmed Free without inventing a sponsorship', () => {
    const { root } = render();
    expect(root.textContent).toContain(ES.accountStatus.free);
    expect(root.querySelector('.access-source')).toBeNull();
  });

  it('shows a finite sponsor date without exposing source identifiers in either language', () => {
    const { root, fixture, access, lang } = render();
    access.access.set({
      ...createFreeAccessSummary(),
      effectivePlanKey: 'premium',
      activeSources: [
        {
          kind: 'sponsored',
          sourceId: 'private-source-id',
          planKey: 'premium',
          validUntil: Date.UTC(2030, 0, 15, 12),
        },
      ],
    });
    fixture.detectChanges();
    expect(root.textContent).toContain('Premium patrocinado · hasta el');
    expect(root.textContent).toContain('2030');
    lang.set('en');
    fixture.detectChanges();
    expect(root.textContent).toContain('Sponsored Premium · until');
    expect(root.textContent).not.toContain('private-source-id');
  });

  it('shows loading instead of asserting a fallback plan', () => {
    const { root, fixture, access } = render();
    access.loading.set(true);
    access.leaseState.set('fallback');
    fixture.detectChanges();
    expect(root.textContent).toContain(ES.accountStatus.loading);
    expect(root.querySelector('.access-plan')).toBeNull();
  });

  it('offers an access read after an error without checkout or a claimed downgrade', () => {
    const { root, fixture, access } = render();
    access.lastError.set('offline');
    fixture.detectChanges();
    expect(root.textContent).toContain(ES.accountStatus.unavailable);
    expect(root.querySelector('.access-plan')).toBeNull();
    (root.querySelector('.access-retry') as HTMLButtonElement).click();
    expect(access.refresh).toHaveBeenCalledOnce();
  });
});
