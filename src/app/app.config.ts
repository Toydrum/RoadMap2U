import {
  ApplicationConfig,
  inject,
  isDevMode,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { APP_CONFIG } from './core/config';
import { AUTH_PROVIDER, AuthProvider } from './core/auth/auth-provider';
import { API_CLIENT, ApiClient } from './core/api/api-client';
import { lazySeam } from './core/lazy-seam';
import { productActivation$ } from './features/shell/product-activation';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // The mock→AWS flip lives in core/config.ts. BOTH adapter pairs are lazy
    // chunks now (0.0.115 bundle): only the chosen side ever downloads, and
    // even that stays off the first paint — every seam method is async, so
    // lazySeam simply awaits the chunk on the first call.
    {
      provide: AUTH_PROVIDER,
      useFactory: (): AuthProvider =>
        APP_CONFIG.backend === 'aws'
          ? lazySeam(() =>
              import('./core/auth/cognito-auth.provider').then((m) => m.createAuthProvider()),
            )
          : lazySeam(() =>
              import('./core/auth/mock-auth.provider').then((m) => new m.MockAuthProvider()),
            ),
    },
    {
      provide: API_CLIENT,
      useFactory: (): ApiClient => {
        const auth = inject(AUTH_PROVIDER);
        return APP_CONFIG.backend === 'aws'
          ? lazySeam(() => import('./core/api/http-api').then((m) => new m.HttpApi(auth)))
          : lazySeam(() => import('./core/api/mock-api').then((m) => new m.MockApi(auth)));
      },
    },
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),
    // Keep Angular's SwUpdate seam available, but do not register/cache the
    // product from `/` or `/account`. The lazy product initializer opens this
    // one-way latch only after local-first startup has completed.
    provideServiceWorker('sw.js', {
      enabled: !isDevMode(),
      registrationStrategy: () => productActivation$,
    }),
  ],
};
