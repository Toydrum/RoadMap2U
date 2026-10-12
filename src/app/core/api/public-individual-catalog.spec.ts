import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSED_INDIVIDUAL_BILLING_CATALOG } from './contracts';
import {
  PUBLIC_INDIVIDUAL_CATALOG,
  PUBLIC_INDIVIDUAL_CATALOG_CONFIG,
} from './public-individual-catalog';

const config = { backend: 'aws', aws: { apiBaseUrl: '' } };

describe('public individual catalog factory', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: PUBLIC_INDIVIDUAL_CATALOG_CONFIG, useValue: config }],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['https://api.example.invalid', 'https://api.example.invalid/'])(
    'uses the published v1 route without identity for %s',
    async (apiBaseUrl) => {
      config.backend = 'aws';
      config.aws.apiBaseUrl = apiBaseUrl;
      const fetch = vi.fn(async () => ({
        ok: true,
        json: async () => CLOSED_INDIVIDUAL_BILLING_CATALOG,
      }));
      vi.stubGlobal('fetch', fetch);

      await expect(TestBed.inject(PUBLIC_INDIVIDUAL_CATALOG)()).resolves.toEqual(
        CLOSED_INDIVIDUAL_BILLING_CATALOG,
      );
      expect(fetch).toHaveBeenCalledOnce();
      const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://api.example.invalid/v1/billing/individual/catalog');
      expect(options.credentials).toBe('omit');
      expect(options.cache).toBe('no-store');
      expect(options.headers).toBeUndefined();
      expect(options.body).toBeUndefined();
      expect(options.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('returns a detached closed mock catalog without a network or database read', async () => {
    config.backend = 'mock';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const open = vi.fn(() => {
      throw new Error('public catalog must not open a database');
    });
    vi.stubGlobal('indexedDB', { open });
    const result = await TestBed.inject(PUBLIC_INDIVIDUAL_CATALOG)();
    expect(result).toEqual(CLOSED_INDIVIDUAL_BILLING_CATALOG);
    expect(result).not.toBe(CLOSED_INDIVIDUAL_BILLING_CATALOG);
    expect(fetch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
