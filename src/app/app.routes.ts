import { Routes } from '@angular/router';

/**
 * Public-first route table. The product route module is a lazy fallback after
 * the exact landing and account routes, so visiting `/` cannot import or boot
 * the local-first application graph.
 */
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/landing').then((m) => m.LandingPage),
    title: 'RoadMap2U — Tu ruta crece contigo',
  },
  {
    path: 'privacy',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/legal-page').then((m) => m.LegalPage),
    data: { legalDocument: 'privacy' },
  },
  {
    path: 'terms',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/legal-page').then((m) => m.LegalPage),
    data: { legalDocument: 'terms' },
  },
  {
    path: 'support',
    pathMatch: 'full',
    loadComponent: () => import('./features/landing/legal-page').then((m) => m.LegalPage),
    data: { legalDocument: 'support' },
  },
  {
    path: 'account',
    loadChildren: () => import('./features/shell/account.routes').then((m) => m.ACCOUNT_ROUTES),
  },
  {
    path: '',
    loadChildren: () => import('./features/shell/product.routes').then((m) => m.PRODUCT_ROUTES),
  },
];
