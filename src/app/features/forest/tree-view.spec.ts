import { NO_ERRORS_SCHEMA, signal, type Signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessService } from '../../core/access/access.service';
import { ConserveriaService } from '../../core/conserveria.service';
import type { Tree, TreeNode } from '../../core/db/schema';
import { CheckinsRepo } from '../../core/repos/checkins.repo';
import { FocusSessionService } from '../../core/focus-session.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { ES } from '../../core/i18n/es';
import { I18nService } from '../../core/i18n/i18n.service';
import { ForestQuotaError } from '../../core/repos/forest-mutations.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { ToastService } from '../../shared/ui/toast.service';
import { TreeViewPage } from './tree-view';

const NOW = 1_800_000_000_000;

function tree(): Tree {
  return {
    id: 'tree-1',
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    name: 'Mi camino',
    accent: 'moss',
    order: 10,
    currentNodeId: 'heart-1',
    heartId: 'heart-1',
    archivedAt: null,
  };
}

function node(id: string, parentId: string | null): TreeNode {
  return {
    id,
    createdAt: NOW,
    updatedAt: NOW,
    rev: 1,
    deletedAt: null,
    treeId: 'tree-1',
    parentId,
    title: id,
    note: '',
    status: 'seed',
    order: 10,
    targetDate: null,
    achievedAt: null,
    branchedAt: null,
    origin: 'planned',
    archivedAt: null,
  };
}

function branchLimitError(): ForestQuotaError {
  return new ForestQuotaError({
    allowed: false,
    reason: 'VISIBLE_BRANCH_LIMIT',
    treeId: 'tree-1',
    current: 10,
    projected: 11,
    limit: 10,
  });
}

interface HarnessOptions {
  readonly plantError?: unknown;
}

async function harness(records: TreeNode[], options: HarnessOptions = {}) {
  const currentTree = tree();
  const byTree = signal(new Map([['tree-1', records]]));
  const byId = signal(new Map(records.map((record) => [record.id, record])));
  const assertCanPlant = vi.fn(() => {
    if (options.plantError) throw options.plantError;
  });
  const plant = vi.fn(async () => {
    if (options.plantError) throw options.plantError;
    return node('branch-new', 'heart-1');
  });
  TestBed.configureTestingModule({
    imports: [TreeViewPage],
    providers: [
      {
        provide: TreesRepo,
        useValue: {
          byId: signal(new Map([['tree-1', currentTree]])),
          setCurrentNode: vi.fn(async () => undefined),
        },
      },
      {
        provide: NodesRepo,
        useValue: {
          byTree,
          byId,
          needsDateReview: signal([]),
          rootsOf: () => [],
          heartOf: () => records.find((record) => record.id === currentTree.heartId) ?? null,
          assertCanPlant,
          plant,
        },
      },
      {
        provide: AccessService,
        useValue: {
          access: signal({ limits: { maxVisibleBranchesPerTree: 10 } }),
        },
      },
      { provide: CheckinsRepo, useValue: { latest: signal(null) } },
      { provide: HarvestsRepo, useValue: { all: signal([]) } },
      { provide: FocusSessionService, useValue: { active: signal(null) } },
      { provide: ConserveriaService, useValue: {} },
      { provide: ToastService, useValue: { show: vi.fn() } },
      {
        provide: I18nService,
        useValue: {
          t: signal(ES),
          fill: (template: string, values: Record<string, string | number>) =>
            template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
          plural: (count: number, forms: { one: string; many: string }) =>
            (count === 1 ? forms.one : forms.many).replace('{count}', String(count)),
        },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap({}),
            queryParams: {},
          },
          queryParamMap: of(convertToParamMap({})),
        },
      },
      { provide: Router, useValue: { navigate: vi.fn(async () => true) } },
    ],
  });
  TestBed.overrideComponent(TreeViewPage, {
    set: { imports: [], schemas: [NO_ERRORS_SCHEMA] },
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(TreeViewPage);
  fixture.componentRef.setInput('id', 'tree-1');
  return {
    fixture,
    page: fixture.componentInstance as unknown as {
      planting: WritableSignal<{ parent: TreeNode | null } | null>;
      newTitle: WritableSignal<string>;
      sowMode: WritableSignal<boolean>;
      sowText: WritableSignal<string>;
      plant(): Promise<void>;
      sow(): Promise<void>;
    },
    count: (fixture.componentInstance as unknown as { branchCount: Signal<number> }).branchCount,
    byTree,
    plant,
  };
}

describe('tree view commercial branch count', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('excludes the technical heart from the displayed branch count', async () => {
    const heart = node('heart-1', null);
    const result = await harness([heart]);

    expect(result.count()).toBe(0);
    result.fixture.detectChanges();
    expect(result.fixture.nativeElement.querySelector('.tree-stats').textContent).toContain('0/10');

    const branches = Array.from({ length: 10 }, (_, index) => node(`branch-${index}`, heart.id));
    result.byTree.set(new Map([['tree-1', [heart, ...branches]]]));
    expect(result.count()).toBe(10);
    result.fixture.detectChanges();
    expect(result.fixture.nativeElement.querySelector('.tree-stats').textContent).toContain(
      '10/10',
    );
  });

  it('keeps a single branch draft open and presents the upgrade choice when branch 11 is denied', async () => {
    const heart = node('heart-1', null);
    const branches = Array.from({ length: 10 }, (_, index) => node(`branch-${index}`, heart.id));
    const { fixture, page } = await harness([heart, ...branches], {
      plantError: branchLimitError(),
    });
    page.planting.set({ parent: null });
    page.newTitle.set('Mi rama once');

    await expect(page.plant()).resolves.toBeUndefined();
    fixture.detectChanges();

    expect(page.planting()).not.toBeNull();
    expect(page.newTitle()).toBe('Mi rama once');
    expect(fixture.nativeElement.querySelector('app-plan-limit-sheet')).not.toBeNull();
  });

  it('keeps a multi-branch draft open when its first projected branch is denied', async () => {
    const heart = node('heart-1', null);
    const branches = Array.from({ length: 10 }, (_, index) => node(`branch-${index}`, heart.id));
    const { fixture, page, plant } = await harness([heart, ...branches], {
      plantError: branchLimitError(),
    });
    page.planting.set({ parent: null });
    page.sowMode.set(true);
    page.sowText.set('Primera\n  Segunda');

    await expect(page.sow()).resolves.toBeUndefined();
    fixture.detectChanges();

    expect(page.planting()).not.toBeNull();
    expect(page.sowText()).toBe('Primera\n  Segunda');
    expect(plant).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('app-plan-limit-sheet')).not.toBeNull();
  });

  it('does not hide unexpected planting failures', async () => {
    const heart = node('heart-1', null);
    const failure = new Error('storage failed');
    const { page } = await harness([heart], { plantError: failure });
    page.planting.set({ parent: null });
    page.newTitle.set('Rama');

    await expect(page.plant()).rejects.toBe(failure);
  });
});
