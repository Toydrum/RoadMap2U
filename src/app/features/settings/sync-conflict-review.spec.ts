import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ES } from '../../core/i18n/es';
import { I18nService } from '../../core/i18n/i18n.service';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { TreesRepo } from '../../core/repos/trees.repo';
import type { SyncConflict } from '../../core/sync/sync-conflict.store';
import { SyncService } from '../../core/sync/sync.service';
import { ToastService } from '../../shared/ui/toast.service';
import { SyncConflictReview } from './sync-conflict-review';

describe('SyncConflictReview', () => {
  it('names the affected branch and lets the user retain it locally, then retry', async () => {
    const conflict: SyncConflict = {
      id: 'conflict-1',
      mutationGroupId: 'group-1',
      code: 'QUOTA_EXCEEDED',
      recordRefs: [{ store: 'nodes', id: 'branch-1', rev: 1, updatedAt: 10 }],
      state: 'pending',
      createdAt: 10,
      updatedAt: 10,
      actions: ['retry', 'local-only'],
    };
    const deviceConflicts = signal([conflict]);
    const resolveConflict = vi.fn(async (_id: string, action: string) => {
      deviceConflicts.set(action === 'local-only' ? [{ ...conflict, state: 'local-only' }] : []);
      return true;
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: I18nService, useValue: { t: () => ES, fill: I18nService.prototype.fill } },
        { provide: SyncService, useValue: { deviceConflicts, phase: () => 'idle', resolveConflict } },
        { provide: TreesRepo, useValue: { byId: () => new Map([['tree-1', { name: 'Jardín' }]]) } },
        { provide: NodesRepo, useValue: {
          byId: () => new Map([['branch-1', { title: 'Sembrar', treeId: 'tree-1' }]]),
        } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(SyncConflictReview);
    fixture.componentRef.setInput('fallbackFocus', document.createElement('h2'));
    const root: HTMLElement = fixture.nativeElement;
    fixture.detectChanges();

    expect(root.textContent).toContain(ES.familia.errors.QUOTA_EXCEEDED);
    expect(root.textContent).toContain('«Sembrar» en «Jardín»');
    root.querySelectorAll('button')[1].click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(resolveConflict).toHaveBeenCalledWith(conflict.id, 'local-only');
    expect(root.textContent).toContain(ES.nube.conflicts.keptLocal);
    expect(root.textContent).toContain(ES.familia.errors.QUOTA_EXCEEDED);
    expect(root.querySelectorAll('button')).toHaveLength(1);
    root.querySelector('button')?.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(resolveConflict).toHaveBeenCalledWith(conflict.id, 'retry');
    expect(root.querySelector('section')).toBeNull();
  });
});
