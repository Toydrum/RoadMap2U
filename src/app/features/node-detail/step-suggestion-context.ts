import type { StepSuggestionsRequest } from '../../core/api/contracts';
import type { Lang, Tree, TreeNode } from '../../core/db/schema';

export function boundedTitle(title: string): string {
  return title.replace(/[\s\p{Cc}\p{Cs}]+/gu, ' ').trim().slice(0, 80)
    .replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
}

export function comparableStepTitle(title: string): string {
  return title.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function buildStepSuggestionContext(
  language: Lang,
  tree: Pick<Tree, 'id' | 'name'>,
  branch: TreeNode,
  byId: ReadonlyMap<string, TreeNode>,
  children: readonly TreeNode[],
): StepSuggestionsRequest | null {
  const treeTitle = boundedTitle(tree.name);
  const branchTitle = boundedTitle(branch.title);
  if (tree.id !== branch.treeId || !treeTitle || !branchTitle) return null;

  const ancestorTitles: string[] = [];
  const visited = new Set([branch.id]);
  let parentId = branch.parentId;
  for (let depth = 0; depth < 3 && parentId; depth++) {
    const parent = byId.get(parentId);
    if (!parent || visited.has(parent.id) || parent.treeId !== tree.id || parent.archivedAt || parent.deletedAt) break;
    visited.add(parent.id);
    const title = boundedTitle(parent.title);
    if (title) ancestorTitles.unshift(title);
    parentId = parent.parentId;
  }

  const child = children[0];
  const existingStep = child ? boundedTitle(child.title) : '';
  return { language, treeTitle, branchTitle, ancestorTitles, existingStepTitles: existingStep ? [existingStep] : [] };
}
