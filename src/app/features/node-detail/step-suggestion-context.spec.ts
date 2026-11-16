import { describe, expect, it } from 'vitest';
import type { TreeNode } from '../../core/db/schema';
import { buildStepSuggestionContext } from './step-suggestion-context';

function node(id: string, title: string, parentId: string | null, treeId = 'tree'): TreeNode {
  return { id, treeId, title, parentId, note: 'private note' } as TreeNode;
}

describe('step suggestion context', () => {
  it('sends only bounded titles, from parent ancestry in tree order', () => {
    const tree = { id: 'tree', name: 'Preparar el balcón' };
    const branch = node('child', 'Plantar albahaca', 'soil');
    const soil = node('soil', 'Preparar tierra', 'pots');
    const pots = node('pots', 'Conseguir macetas', 'plan');
    const plan = node('plan', 'Planear el jardín', 'hidden');
    const unrelated = node('hidden', 'Never send this title', null);
    const records = new Map([soil, pots, plan, unrelated].map((entry) => [entry.id, entry]));

    expect(buildStepSuggestionContext('es', tree, branch, records, [
      node('first', 'Lavar maceta', branch.id),
      node('second', 'Otro pasito', branch.id),
    ])).toEqual({
      language: 'es',
      treeTitle: 'Preparar el balcón',
      branchTitle: 'Plantar albahaca',
      ancestorTitles: ['Planear el jardín', 'Conseguir macetas', 'Preparar tierra'],
      existingStepTitles: ['Lavar maceta'],
    });
  });

  it('stops at invalid and cyclic links and does not split a Unicode title', () => {
    const tree = { id: 'tree', name: 'X'.repeat(79) + '🌱' };
    const branch = node('child', 'Plant    basil', 'parent');
    const parent = node('parent', 'Set up the garden', branch.id);
    const outside = node('parent', 'Other tree', null, 'different');

    expect(buildStepSuggestionContext('en', tree, branch, new Map([[parent.id, parent]]), []))
      .toMatchObject({ treeTitle: 'X'.repeat(79), branchTitle: 'Plant basil', ancestorTitles: ['Set up the garden'] });
    expect(buildStepSuggestionContext('en', tree, branch, new Map([[outside.id, outside]]), []))
      .toMatchObject({ ancestorTitles: [] });
  });
});
