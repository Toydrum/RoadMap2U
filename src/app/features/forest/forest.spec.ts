import { NO_ERRORS_SCHEMA, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConserveriaService } from '../../core/conserveria.service';
import { FocusSessionService } from '../../core/focus-session.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ES } from '../../core/i18n/es';
import { PerchAnchorService } from '../../core/perch-anchor.service';
import { type Tree, type TreeNode, newSyncBase } from '../../core/db/schema';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { ForestQuotaError } from '../../core/repos/forest-mutations.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { SettingsService } from '../../core/repos/settings.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { ToastService } from '../../shared/ui/toast.service';
import { ForestPage } from './forest';

function quotaError(reason: 'ACCESS_LEASE_REQUIRED' | 'ACTIVE_TREE_LIMIT'): ForestQuotaError {
  return new ForestQuotaError(
    reason === 'ACCESS_LEASE_REQUIRED'
      ? { allowed: false, reason }
      : { allowed: false, reason, current: 2, projected: 3, limit: 2 },
  );
}

async function forestHarness(options: { createError?: unknown; plantManyError?: unknown }) {
  const base = newSyncBase(1_800_000_000_000);
  const newborn: Tree = {
    ...base,
    name: 'La escuela',
    accent: 'sky',
    order: 10,
    currentNodeId: `${base.id}-heart`,
    heartId: `${base.id}-heart`,
    archivedAt: null,
  };
  const active = signal<Tree[]>([]);
  const byId = signal(new Map<string, Tree>());
  const create = vi.fn(async () => {
    if (options.createError) throw options.createError;
    active.set([newborn]);
    byId.set(new Map([[newborn.id, newborn]]));
    return newborn;
  });
  const trees = {
    active,
    byId,
    create,
    setOrder: vi.fn(async () => undefined),
  };
  const plantMany = vi.fn(async () => {
    if (options.plantManyError) throw options.plantManyError;
  });
  const nodesByTree = signal(new Map<string, TreeNode[]>());
  const nodes = {
    visible: signal([]),
    byId: signal(new Map()),
    byTree: nodesByTree,
    plantMany,
  };
  const i18n = {
    t: signal(ES),
    fill: (template: string, values: Record<string, string | number>) =>
      template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
    plural: (count: number, forms: { one: string; many: string }) =>
      (count === 1 ? forms.one : forms.many).replace('{count}', String(count)),
  };
  const router = { url: '/forest?plant=1', navigate: vi.fn(async () => true) };

  TestBed.configureTestingModule({
    imports: [ForestPage],
    providers: [
      { provide: TreesRepo, useValue: trees },
      { provide: NodesRepo, useValue: nodes },
      { provide: HarvestsRepo, useValue: { all: signal([]) } },
      { provide: CheckinsRepo, useValue: { latest: signal(null) } },
      {
        provide: SettingsService,
        useValue: { settings: signal({ startersHidden: false }), patch: vi.fn() },
      },
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: ConserveriaService, useValue: {} },
      { provide: FocusSessionService, useValue: { active: signal(null) } },
      { provide: PerchAnchorService, useValue: { claim: vi.fn(), release: vi.fn() } },
      { provide: I18nService, useValue: i18n },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: { has: () => false }, queryParams: {} },
        },
      },
      { provide: Router, useValue: router },
    ],
  });
  TestBed.overrideComponent(ForestPage, {
    set: { imports: [], schemas: [NO_ERRORS_SCHEMA] },
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(ForestPage);
  fixture.detectChanges();
  return { fixture, create, newborn, nodesByTree, plantMany, router, treeById: byId };
}

describe('forest growth errors', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('excludes the technical heart from the forest card branch count', async () => {
    const { fixture, newborn, nodesByTree, treeById } = await forestHarness({});
    const heart = { id: newborn.heartId } as TreeNode;
    const branches = Array.from(
      { length: 10 },
      (_, index) => ({ id: `branch-${index}` }) as TreeNode,
    );
    treeById.set(new Map([[newborn.id, newborn]]));
    nodesByTree.set(new Map([[newborn.id, [heart, ...branches]]]));
    const page = fixture.componentInstance as unknown as {
      countFor(treeId: string): number;
    };

    expect(page.countFor(newborn.id)).toBe(10);
  });

  it('keeps the planting sheet and draft open while presenting the third-tree upgrade choice', async () => {
    const { fixture } = await forestHarness({
      createError: quotaError('ACTIVE_TREE_LIMIT'),
    });
    const page = fixture.componentInstance as unknown as {
      creating: WritableSignal<boolean>;
      newName: WritableSignal<string>;
      newAccent: WritableSignal<string>;
      create(): Promise<void>;
    };
    page.creating.set(true);
    page.newName.set('Mi tercer árbol');
    page.newAccent.set('sky');

    await page.create();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('form')).not.toBeNull();
    expect(page.newName()).toBe('Mi tercer árbol');
    expect(page.newAccent()).toBe('sky');
    expect(fixture.nativeElement.querySelector('app-plan-limit-sheet')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('explains a starter denial in the empty clearing', async () => {
    const { fixture } = await forestHarness({
      createError: quotaError('ACCESS_LEASE_REQUIRED'),
    });
    const page = fixture.componentInstance as unknown as {
      plantStarter(kind: 'school' | 'home' | 'project'): Promise<void>;
    };

    await page.plantStarter('school');
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('comprobar tu acceso');
  });

  it('keeps a starter branch failure visible after the newborn tree appears', async () => {
    const { fixture } = await forestHarness({
      plantManyError: new Error('synthetic branch commit failure'),
    });
    const page = fixture.componentInstance as unknown as {
      plantStarter(kind: 'school' | 'home' | 'project'): Promise<void>;
    };

    await page.plantStarter('school');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.plot')).not.toBeNull();
    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain(
      'El árbol se creó, pero no pudimos plantar sus ramas de ejemplo',
    );
  });

  it('sends a guest key intent to account with a local return URL', async () => {
    const { fixture, router } = await forestHarness({});
    const page = fixture.componentInstance as unknown as { redeemFromPlanLimit(): void };

    page.redeemFromPlanLimit();

    expect(router.navigate).toHaveBeenCalledWith(['/account'], {
      queryParams: { intent: 'redeem', returnUrl: '/forest?plant=1' },
    });
  });
});
