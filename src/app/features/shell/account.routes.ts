import { Routes } from '@angular/router';
import { authReadyGate } from './auth-initializer';

/** Public auth machine: cached identity and preferences, no product startup. */
export const ACCOUNT_ROUTES: Routes = [
  {
    path: '',
    canActivate: [authReadyGate],
    loadComponent: () => import('../account/account').then((m) => m.AccountPage),
    title: 'RoadMap2U — Cuenta',
  },
];
