import { Routes } from '@angular/router';
import { authReadyGate } from './auth-initializer';

/** Public auth machine: cached identity and preferences, no product startup. */
export const ACCOUNT_ROUTES: Routes = [
  {
    path: 'subscription',
    pathMatch: 'full',
    canActivate: [authReadyGate],
    loadComponent: () => import('../billing/subscription-page').then((m) => m.SubscriptionPage),
    title: 'RoadMap2U — Premium',
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authReadyGate],
    loadComponent: () => import('../account/account').then((m) => m.AccountPage),
    title: 'RoadMap2U — Cuenta',
  },
];
