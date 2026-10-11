import { InjectionToken, inject } from '@angular/core';
import { APP_CONFIG } from '../config';
import { API_PATHS, CLOSED_INDIVIDUAL_BILLING_CATALOG } from './contracts';

export const PUBLIC_INDIVIDUAL_CATALOG_CONFIG = new InjectionToken<typeof APP_CONFIG>(
  'PUBLIC_INDIVIDUAL_CATALOG_CONFIG',
  { providedIn: 'root', factory: () => APP_CONFIG },
);

/** Public read seam: does not instantiate identity, mock cloud, or storage. */
export const PUBLIC_INDIVIDUAL_CATALOG = new InjectionToken<() => Promise<unknown>>(
  'PUBLIC_INDIVIDUAL_CATALOG',
  {
    providedIn: 'root',
    factory: () => {
      const config = inject(PUBLIC_INDIVIDUAL_CATALOG_CONFIG);
      return async () => {
        if (config.backend === 'mock') return structuredClone(CLOSED_INDIVIDUAL_BILLING_CATALOG);
        const response = await fetch(
          `${config.aws.apiBaseUrl.replace(/\/$/, '')}/v1${API_PATHS.individualBillingCatalog}`,
          { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) throw new Error('individual catalog unavailable');
        return response.json();
      };
    },
  },
);
