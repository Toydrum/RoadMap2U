import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ES } from '../../core/i18n/es';
import { I18nService } from '../../core/i18n/i18n.service';
import { RemindersService } from '../../core/reminders.service';
import { ForestQuotaError } from '../../core/repos/forest-mutations.service';
import { HarvestsRepo } from '../../core/repos/harvests.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { SessionsRepo } from '../../core/repos/sessions.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import { BloomBurstService } from '../../shared/ui/bloom-burst';
import { HarvestSkyService } from '../../shared/ui/harvest-sky';
import { ToastService } from '../../shared/ui/toast.service';
import { PromiseService } from '../cosecha/promise.service';
import { NodeDetail } from './node-detail';

function setup(error?: ForestQuotaError) {
  const plant = vi.fn(async () => undefined);
  const plantMany = vi.fn(async () => {
    if (error) throw error;
  });
  const show = vi.fn();
  const i18n = {
    t: signal(ES),
    fill: (template: string, values: { limit: number }) => template.replace('{limit}', String(values.limit)),
    plural: (count: number, forms: { one: string; many: string }) =>
      (count === 1 ? forms.one : forms.many).replace('{count}', String(count)),
  };
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      { provide: I18nService, useValue: i18n },
      { provide: NodesRepo, useValue: { plant, plantMany } },
      { provide: ToastService, useValue: { show } },
      ...[TreesRepo, SessionsRepo, Router, HarvestsRepo, BloomBurstService, HarvestSkyService,
        PromiseService, RemindersService].map((provide) => ({ provide, useValue: {} })),
    ],
  });
  TestBed.overrideComponent(NodeDetail, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('node', { id: 'parent', treeId: 'tree' });
  const detail = fixture.componentInstance as unknown as {
    startCrumble(): void;
    crumbleNext(skip: boolean): Promise<void>;
    crumbleAnswer: WritableSignal<string>;
    crumbleStep: WritableSignal<number | null>;
  };
  return { detail, plant, plantMany, show };
}

async function enterAnswers(detail: ReturnType<typeof setup>['detail']) {
  detail.startCrumble();
  for (const answer of ['Uno', 'Dos', 'Tres']) {
    detail.crumbleAnswer.set(answer);
    await detail.crumbleNext(false);
  }
}

describe('Desmenuzar quota handling', () => {
  it('submits all answers as one batch of siblings', async () => {
    const { detail, plant, plantMany } = setup();
    await enterAnswers(detail);

    expect(plantMany).toHaveBeenCalledExactlyOnceWith('tree', [
      { parentId: 'parent', title: 'Uno' },
      { parentId: 'parent', title: 'Dos' },
      { parentId: 'parent', title: 'Tres' },
    ]);
    expect(plant).not.toHaveBeenCalled();
    expect(detail.crumbleStep()).toBeNull();
  });

  it('shows the branch limit and preserves the final answer when the batch is denied', async () => {
    const { detail, plant, show } = setup(new ForestQuotaError({
      allowed: false, reason: 'VISIBLE_BRANCH_LIMIT', treeId: 'tree', current: 4, projected: 7, limit: 5,
    }));
    await enterAnswers(detail);

    expect(detail.crumbleStep()).toBe(2);
    expect(detail.crumbleAnswer()).toBe('Tres');
    expect(plant).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith({
      message: ES.forest.errors.visibleBranchLimit.replace('{limit}', '5'),
    });
  });
});
