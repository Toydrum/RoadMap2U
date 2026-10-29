import { describe, expect, it } from 'vitest';
import * as contracts from './contracts';
import { ES } from '../i18n/es';
import { EN } from '../i18n/en';
import { commonAccountDocument, privacyDocument } from './privacy-document';
import { subscriptionTermsDocument } from './subscription-terms-documents';

const sha = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

describe('immutable privacy document families', () => {
  it('keeps historical adult and private payloads independent of public legal edits', async () => {
    for (const [language, dictionary] of [['es', ES], ['en', EN]] as const) {
      const before = await sha(contracts.adultPrivacyDocument(language, dictionary));
      const changed = structuredClone(dictionary);
      changed.legal.privacy.intro = 'Public account notice changed';
      expect(await sha(contracts.adultPrivacyDocument(language, changed))).toBe(before);
    }
  });
  it('exposes a separate common account document family', () => {
    expect((contracts as unknown as Record<string, unknown>)['commonAccountPrivacyDocument']).toBeTypeOf('function');
  });
  it('retains the original ES/EN historical hashes and separates current common evidence', async () => {
    expect((await privacyDocument('es')).hash).toBe('6a9e3f1294ae9b10dd0c6fb47d43896580a955fae4153d2c675fb39b112ca143');
    expect((await privacyDocument('en')).hash).toBe('f7157b1d55ca253d1e67ec343d40cd25db75859eeb5211ecbd9d9b52ebeb48a5');
    for (const language of ['es', 'en'] as const) {
      const common = await commonAccountDocument(language);
      expect(common.hash).not.toBe((await privacyDocument(language)).hash);
      expect(common.document.declaration).not.toHaveProperty('adult');
      expect(common.document.notice).toEqual((language === 'es' ? ES : EN).legal.privacy);
      expect(common.document.terms).toEqual((language === 'es' ? ES : EN).legal.terms);
    }
  });
  it('retains previous subscription terms while new terms describe an own account', () => {
    expect(subscriptionTermsDocument('en', 'individual-subscription-2026-10-28-v1').text).toContain('adult account');
    expect(subscriptionTermsDocument('en').text).not.toContain('adult account');
    expect(subscriptionTermsDocument('es').text).not.toContain('cuenta adulta');
    expect(subscriptionTermsDocument('es').text).toContain('$114.84 MXN');
    expect(subscriptionTermsDocument('en').text).toContain('existing private accounts');
    expect(subscriptionTermsDocument('es').text).toContain('cuentas privadas existentes');
    expect(subscriptionTermsDocument('es').text).toBe(ES.billing.termsText);
    expect(subscriptionTermsDocument('en').text).toBe(EN.billing.termsText);
  });
});
