import { describe, expect, it } from 'vitest';
import { ACCOUNT_ROUTES } from '../shell/account.routes';
import { routes } from '../../app.routes';
import { ES } from '../../core/i18n/es';
import { EN } from '../../core/i18n/en';

describe('individual subscription entry and commercial copy', () => {
  it('has a lazy account subscription route before the generic auth page', () => {
    expect(ACCOUNT_ROUTES[0]?.path).toBe('subscription');
    expect(ACCOUNT_ROUTES[0]?.loadComponent).toBeTypeOf('function');
  });
  it('has a public commercial terms route outside the product startup', () => {
    expect(
      routes.find((route) => route.path === 'subscription-terms')?.data?.['legalDocument'],
    ).toBe('subscription');
  });
  it('describes recurring inclusive MXN charges and support in both consent texts', () => {
    for (const dictionary of [ES, EN]) {
      const billing = (
        dictionary as unknown as { billing?: { termsText: string; termsVersion: string } }
      ).billing;
      expect(billing?.termsVersion).toBe('individual-subscription-2026-10-12-draft-v2');
      expect(billing?.termsText).toContain('$114.84 MXN');
      expect(billing?.termsText).toContain('$1,100.84 MXN');
      expect(billing?.termsText).toContain('overseer@roadmap2u.com');
      expect(billing?.termsText).toContain('CFDI');
      expect(billing?.termsText).toContain('jescricdy1@gmail.com');
      expect(dictionary.billing.supportHint).toContain('jescricdy1@gmail.com');
      expect(dictionary.billing.supportHint).toContain('overseer@roadmap2u.com');
    }
  });
});
