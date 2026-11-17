import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type StepSuggestionsRequest } from '../../core/api/contracts';
import { StepSuggestionsService } from '../../core/api/step-suggestions.service';
import type { TreeNode } from '../../core/db/schema';
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
  const session = signal<string | null>('test-session');
  const generate = vi.fn(async () => ['Preparar la maceta']);
  const cached = vi.fn<(_branchId: string, _context: StepSuggestionsRequest) => readonly string[] | null>(() => null);
  const children = signal<readonly TreeNode[]>([]);
  const i18n = {
    t: signal(ES),
    lang: signal('es'),
    fill: (template: string, values: Record<string, string | number>) =>
      template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? '')),
    plural: (count: number, forms: { one: string; many: string }) =>
      (count === 1 ? forms.one : forms.many).replace('{count}', String(count)),
  };
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      { provide: I18nService, useValue: i18n },
      { provide: NodesRepo, useValue: { plant, plantMany, byId: signal(new Map()), childrenOf: children } },
      { provide: StepSuggestionsService, useValue: { session, available: () => true, checkEligibility: vi.fn(), cached, generate } },
      { provide: ToastService, useValue: { show } },
      ...[TreesRepo, SessionsRepo, Router, HarvestsRepo, BloomBurstService, HarvestSkyService,
        PromiseService, RemindersService].map((provide) => ({ provide, useValue: {} })),
    ],
  });
  TestBed.overrideComponent(NodeDetail, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('node', { id: 'parent', treeId: 'tree', title: 'Plantar albahaca', status: 'seed', parentId: null });
  fixture.componentRef.setInput('tree', { id: 'tree', name: 'Preparar el balcón' });
  const detail = fixture.componentInstance as unknown as {
    startCrumble(): void;
    crumbleNext(skip: boolean): Promise<void>;
    crumbleAnswer: WritableSignal<string>;
    crumbleStep: WritableSignal<number | null>;
    openStepSuggestions(): void;
    setStepSuggestionFocus(value: string): void;
    canGenerateStepSuggestion(): boolean;
    suggestionFocusLabel(): string;
    generateStepSuggestions(): Promise<void>;
    editStepSuggestion(index: number, title: string): void;
    saveStepSuggestions(): Promise<void>;
    closeStepSuggestions(): void;
    stepSuggestionReview(): unknown;
  };
  return { detail, fixture, plant, plantMany, show, session, cached, generate, children };
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

describe('step suggestions in Desmenuzar', () => {
  it.each(['Aprender ajedrez', 'Learning chess'])('requires a concrete focus before generating for an empty learning root (%s)', async (title) => {
    const { detail, fixture, generate } = setup();
    fixture.componentRef.setInput('tree', { id: 'tree', name: title });
    fixture.componentRef.setInput('node', { id: 'parent', treeId: 'tree', title, status: 'seed', parentId: null });

    detail.openStepSuggestions();
    detail.setStepSuggestionFocus('   ');
    expect(detail.canGenerateStepSuggestion()).toBe(false);
    await detail.generateStepSuggestions();
    expect(generate).not.toHaveBeenCalled();

    detail.setStepSuggestionFocus('El movimiento del caballo');
    expect(detail.canGenerateStepSuggestion()).toBe(true);
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledExactlyOnceWith('parent', expect.objectContaining({ focus: 'El movimiento del caballo' }));
  });

  it('allows generation without focus when a learning root already has a step', async () => {
    const { detail, fixture, generate, children } = setup();
    const title = 'Aprender ajedrez';
    fixture.componentRef.setInput('tree', { id: 'tree', name: title });
    fixture.componentRef.setInput('node', { id: 'parent', treeId: 'tree', title, status: 'seed', parentId: null });
    children.set([{ title: 'Colocar las piezas' } as TreeNode]);

    detail.openStepSuggestions();
    expect(detail.canGenerateStepSuggestion()).toBe(true);
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('shows context before requesting one next step and plants the edit', async () => {
    const { detail, generate, plantMany } = setup();
    detail.openStepSuggestions();
    detail.setStepSuggestionFocus('Otro enfoque');
    expect(generate).not.toHaveBeenCalled();
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledExactlyOnceWith('parent', {
      language: 'es',
      treeTitle: 'Preparar el balcón',
      branchTitle: 'Plantar albahaca',
      ancestorTitles: [],
      existingStepTitles: [],
      maxSuggestions: 1,
    });
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'editing', rows: [{ title: 'Preparar la maceta', selected: true }] });
    detail.editStepSuggestion(0, 'Llenar una maceta');
    await detail.saveStepSuggestions();
    expect(plantMany).toHaveBeenCalledExactlyOnceWith('tree', [
      { parentId: 'parent', title: 'Llenar una maceta' },
    ]);
  });

  it('sends an explicitly entered focus for a matching tree root only after confirmation', async () => {
    const { detail, fixture, generate, children } = setup();
    fixture.componentRef.setInput('tree', { id: 'tree', name: 'Plantar albahaca' });
    children.set([{ title: 'Elegir albahaca' } as TreeNode]);

    detail.openStepSuggestions();
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'disclose', focusInput: '' });
    detail.setStepSuggestionFocus('  Usar una maceta\npequeña  ');
    expect(generate).not.toHaveBeenCalled();
    await detail.generateStepSuggestions();

    expect(generate).toHaveBeenCalledExactlyOnceWith('parent', expect.objectContaining({
      focus: 'Usar una maceta pequeña',
      existingStepTitles: ['Elegir albahaca'],
    }));
  });

  it('reopens the context preview without sending the old focus if the tree changes', async () => {
    const { detail, fixture, generate } = setup();
    fixture.componentRef.setInput('tree', { id: 'tree', name: 'Plantar albahaca' });
    detail.openStepSuggestions();
    detail.setStepSuggestionFocus('Usar una maceta');
    fixture.componentRef.setInput('tree', { id: 'tree', name: 'Preparar el balcón' });

    await detail.generateStepSuggestions();

    expect(generate).not.toHaveBeenCalled();
    expect(detail.stepSuggestionReview()).toMatchObject({
      phase: 'disclose',
      context: { treeTitle: 'Preparar el balcón' },
    });
  });

  it('only reuses a result for the same focus and still lets a root generate without a focus', async () => {
    const { detail, fixture, cached, generate } = setup();
    fixture.componentRef.setInput('tree', { id: 'tree', name: 'Plantar albahaca' });
    cached.mockImplementation((_branchId, context) => context.focus === 'Elegir tierra' ? ['Sacar una bolsa de tierra'] : null);

    detail.openStepSuggestions();
    detail.setStepSuggestionFocus('Elegir tierra');
    await detail.generateStepSuggestions();
    expect(generate).not.toHaveBeenCalled();
    expect(cached.mock.lastCall?.[1]).toMatchObject({ focus: 'Elegir tierra', maxSuggestions: 1 });
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'editing', rows: [{ title: 'Sacar una bolsa de tierra' }] });

    detail.closeStepSuggestions();
    detail.openStepSuggestions();
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledOnce();
    expect(cached.mock.lastCall?.[1]).not.toHaveProperty('focus');
  });

  it('asks for the missing object and waits for a new answer before retrying a child branch', async () => {
    const { detail, fixture, generate } = setup();
    fixture.componentRef.setInput('node', { id: 'parent', treeId: 'tree', title: 'Dejarlo listo', status: 'seed', parentId: 'root' });
    generate.mockRejectedValueOnce(new ApiError('STEP_SUGGESTIONS_CONTEXT_REQUIRED', 'object'));

    detail.openStepSuggestions();
    await detail.generateStepSuggestions();
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'disclose', focusInput: '' });
    expect(detail.suggestionFocusLabel()).toBe('¿Qué quieres dejar listo?');
    expect(detail.canGenerateStepSuggestion()).toBe(false);
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledOnce();

    detail.setStepSuggestionFocus(' Preparar una maceta para la albahaca ');
    expect(detail.canGenerateStepSuggestion()).toBe(true);
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenLastCalledWith('parent', expect.objectContaining({
      branchTitle: 'Dejarlo listo', focus: 'Preparar una maceta para la albahaca', maxSuggestions: 1,
    }));
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'editing' });
  });

  it('keeps the earlier focus editable when asking for a destination and avoids resending it unchanged', async () => {
    const { detail, fixture, generate } = setup();
    fixture.componentRef.setInput('tree', { id: 'tree', name: 'Plantar albahaca' });
    generate.mockRejectedValueOnce(new ApiError('STEP_SUGGESTIONS_CONTEXT_REQUIRED', 'destination'));

    detail.openStepSuggestions();
    detail.setStepSuggestionFocus('Mover la maceta sin volcarla');
    await detail.generateStepSuggestions();
    expect(detail.stepSuggestionReview()).toMatchObject({ phase: 'disclose', focusInput: 'Mover la maceta sin volcarla' });
    expect(detail.suggestionFocusLabel()).toBe('¿Dónde quieres que quede?');

    detail.setStepSuggestionFocus('  Mover la maceta sin volcarla  ');
    expect(detail.canGenerateStepSuggestion()).toBe(false);
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenCalledOnce();

    detail.setStepSuggestionFocus('Mover la maceta a la repisa sin volcarla');
    await detail.generateStepSuggestions();
    expect(generate).toHaveBeenLastCalledWith('parent', expect.objectContaining({ focus: 'Mover la maceta a la repisa sin volcarla' }));
  });

  it('never saves a result from the previous session', async () => {
    const { detail, plantMany, session } = setup();
    detail.openStepSuggestions();
    const pending = detail.generateStepSuggestions();
    session.set('another-session');
    await pending;
    expect(detail.stepSuggestionReview()).toBeNull();
    await detail.saveStepSuggestions();
    expect(plantMany).not.toHaveBeenCalled();
  });

  it('lets the user close a review without saving it', async () => {
    const { detail, plantMany } = setup();
    detail.openStepSuggestions();
    await detail.generateStepSuggestions();
    detail.closeStepSuggestions();
    await detail.saveStepSuggestions();
    expect(plantMany).not.toHaveBeenCalled();
  });

  it('reserves a single request for a double click and shows the daily limit', async () => {
    const { detail, generate, plantMany } = setup();
    generate.mockRejectedValueOnce(new ApiError('RATE_LIMITED'));
    detail.openStepSuggestions();
    await Promise.all([detail.generateStepSuggestions(), detail.generateStepSuggestions()]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(detail.stepSuggestionReview()).toMatchObject({
      phase: 'error', error: expect.stringContaining('El cupo se renueva'),
    });
    expect(plantMany).not.toHaveBeenCalled();
  });

  it('keeps the chosen edits when the branch quota blocks saving', async () => {
    const { detail, show } = setup(new ForestQuotaError({
      allowed: false, reason: 'VISIBLE_BRANCH_LIMIT', treeId: 'tree', current: 5, projected: 6, limit: 5,
    }));
    detail.openStepSuggestions();
    await detail.generateStepSuggestions();
    detail.editStepSuggestion(0, 'Llenar una maceta');
    await detail.saveStepSuggestions();

    expect(detail.stepSuggestionReview()).toMatchObject({
      phase: 'editing', rows: expect.arrayContaining([{ title: 'Llenar una maceta', selected: true }]),
    });
    expect(show).toHaveBeenCalledWith({
      message: ES.forest.errors.visibleBranchLimit.replace('{limit}', '5'),
    });
  });
});
