import { Injectable, inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { authRequiredGate } from '../../core/auth/auth.guard';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { VisitNodesRepo, VisitTreesRepo } from '../../core/visit/visit-repos';
import { VisitSession } from '../../core/visit/visit-session';
import { productReadyGate } from './product-initializer';
import { ProductShell } from './product-shell';

/** Loads the visited forest before the subtree paints (idempotent per user). */
const visitGate: CanActivateFn = (route) => {
  const userId = route.paramMap.get('userId') ?? '';
  return inject(VisitSession)
    .load(userId)
    .then(() => true);
};

const CHECK_IN_COOLDOWN_MS = 30 * 60 * 1000;

/** One gentle diversion per app-open. After that, tabs go exactly where they say. */
@Injectable({ providedIn: 'root' })
export class SessionGate {
  consumed = false;
}

const checkInGate: CanActivateFn = () => {
  const gate = inject(SessionGate);
  if (gate.consumed) return true;
  gate.consumed = true;
  const settings = inject(SettingsService).settings();
  const fresh =
    settings.lastCheckInAt !== null && Date.now() - settings.lastCheckInAt < CHECK_IN_COOLDOWN_MS;
  return fresh ? true : inject(Router).createUrlTree(['/check-in']);
};

/** Every local-first route lives under one initialized chrome boundary. */
export const PRODUCT_ROUTES: Routes = [
  {
    path: '',
    canActivate: [productReadyGate],
    component: ProductShell,
    children: [
      {
        path: 'check-in',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../check-in/check-in').then((m) => m.CheckInPage),
        title: 'RoadMap2U',
      },
      {
        path: 'ahora',
        canActivate: [authRequiredGate, checkInGate],
        loadComponent: () => import('../ahora/ahora').then((m) => m.AhoraPage),
        title: 'RoadMap2U — Ahora',
      },
      {
        path: 'forest',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../forest/forest').then((m) => m.ForestPage),
        title: 'RoadMap2U — Mi bosque',
      },
      {
        path: 'tree/:id',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../forest/tree-view').then((m) => m.TreeViewPage),
        title: 'RoadMap2U',
      },
      {
        path: 'timer',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../timer/timer').then((m) => m.TimerPage),
        title: 'RoadMap2U — Enfoque',
      },
      {
        // Someone else's forest: route-scoped repos shadow the real ones, so
        // the whole tree toolkit never touches the visitor's local IndexedDB.
        path: 'visit/:userId',
        canActivate: [authRequiredGate, visitGate],
        providers: [
          VisitSession,
          VisitTreesRepo,
          VisitNodesRepo,
          { provide: TreesRepo, useExisting: VisitTreesRepo },
          { provide: NodesRepo, useExisting: VisitNodesRepo },
        ],
        children: [
          {
            path: '',
            loadComponent: () => import('../visit/visit-forest').then((m) => m.VisitForestPage),
            title: 'RoadMap2U — De visita',
          },
          {
            path: 'tree/:id',
            loadComponent: () => import('../forest/tree-view').then((m) => m.TreeViewPage),
            title: 'RoadMap2U — De visita',
          },
        ],
      },
      {
        path: 'settings',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../settings/settings').then((m) => m.SettingsPage),
        title: 'RoadMap2U — Ajustes',
      },
      {
        path: 'guide',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../guide/guide').then((m) => m.GuidePage),
        title: 'RoadMap2U — Guía',
      },
      {
        path: 'trail',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../trail/trail').then((m) => m.TrailPage),
        title: 'RoadMap2U — Huellas',
      },
      {
        path: 'almanaque',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../almanaque/almanaque').then((m) => m.AlmanaquePage),
        title: 'RoadMap2U — Almanaque',
      },
      {
        path: 'cosecha',
        canActivate: [authRequiredGate],
        loadComponent: () => import('../cosecha/cosecha').then((m) => m.CosechaPage),
        title: 'RoadMap2U — Cosecha',
      },
      { path: '**', redirectTo: 'ahora' },
    ],
  },
];
