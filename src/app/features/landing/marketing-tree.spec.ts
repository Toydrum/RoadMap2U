import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MarketingTree } from './marketing-tree';

const ES_DEMO = {
  goal: 'Aprender francés',
  vocabulary: 'Practico vocabulario',
  listening: 'Escucho un audio',
  speaking: 'Converso en francés',
  reading: 'Leo un texto corto',
  description:
    'Árbol de ejemplo: Aprender francés, con ramas para practicar vocabulario, escuchar, conversar y leer.',
};
const EN_DEMO = {
  goal: 'Learn French',
  vocabulary: 'I practise vocabulary',
  listening: 'I listen to an audio clip',
  speaking: 'I speak French',
  reading: 'I read a short text',
  description:
    'Example tree: Learn French, with branches for vocabulary, listening, speaking, and reading.',
};

describe('marketing demo tree labels', () => {
  beforeEach(() => TestBed.resetTestingModule());

  async function tree(variant = 'demo', labels = ES_DEMO) {
    await TestBed.configureTestingModule({ imports: [MarketingTree] }).compileComponents();
    const fixture = TestBed.createComponent(MarketingTree);
    fixture.componentRef.setInput('variant', variant);
    fixture.componentRef.setInput('demoLabels', labels);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the goal and four concrete branch tasks with an accessible localized description', async () => {
    const { root } = await tree();
    const demo = root.querySelector('.demo-figure');
    expect(demo?.getAttribute('role')).toBe('img');
    expect(demo?.getAttribute('aria-label')).toBe(ES_DEMO.description);
    expect(demo?.getAttribute('aria-hidden')).not.toBe('true');
    expect(
      Array.from(root.querySelectorAll('.demo-label'), (label) => label.textContent?.trim()),
    ).toEqual([
      ES_DEMO.goal,
      ES_DEMO.vocabulary,
      ES_DEMO.listening,
      ES_DEMO.speaking,
      ES_DEMO.reading,
    ]);
    expect(root.textContent).not.toMatch(/heart|path-[a-d]|step-[ab]/);
    expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('updates visible labels and the image description when the language changes', async () => {
    const { root, fixture } = await tree();
    fixture.componentRef.setInput('demoLabels', EN_DEMO);
    fixture.detectChanges();
    expect(root.querySelector('.demo-figure')?.getAttribute('aria-label')).toBe(
      EN_DEMO.description,
    );
    for (const text of [
      EN_DEMO.goal,
      EN_DEMO.vocabulary,
      EN_DEMO.listening,
      EN_DEMO.speaking,
      EN_DEMO.reading,
    ]) {
      expect(root.textContent).toContain(text);
    }
    expect(root.textContent).not.toContain(ES_DEMO.goal);
  });

  it('keeps an unlabelled demo decorative instead of inventing an accessible description', async () => {
    await TestBed.configureTestingModule({ imports: [MarketingTree] }).compileComponents();
    const fixture = TestBed.createComponent(MarketingTree);
    fixture.componentRef.setInput('variant', 'demo');
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="img"]')).toBeNull();
    expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.demo-label')).toBeNull();
  });

  it.each(['hero', 'sap', 'branch', 'grown'])(
    'keeps the %s silhouette decorative even when labels are supplied',
    async (variant) => {
      const { root } = await tree(variant);
      expect(root.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(root.querySelector('[role="img"]')).toBeNull();
      expect(root.querySelector('.demo-label')).toBeNull();
    },
  );
});
