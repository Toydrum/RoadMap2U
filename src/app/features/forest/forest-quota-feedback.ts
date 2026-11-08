import { ApiError } from '../../core/api/contracts';
import type { Tree } from '../../core/db/schema';
import type { I18nService } from '../../core/i18n/i18n.service';
import { ForestQuotaError } from '../../core/repos/forest-mutations.service';
import type { TreesRepo } from '../../core/repos/trees.repo';
import type { ToastService } from '../../shared/ui/toast.service';

export function forestQuotaMessage(i18n: I18nService, error: unknown): string | undefined {
  if (error instanceof ApiError && error.code === 'QUOTA_EXCEEDED') {
    return i18n.t().familia.errors.QUOTA_EXCEEDED;
  }
  if (!(error instanceof ForestQuotaError)) return undefined;

  const copy = i18n.t().forest.errors;
  switch (error.decision.reason) {
    case 'ACCESS_LEASE_REQUIRED':
      return copy.accessLeaseRequired;
    case 'ACTIVE_TREE_LIMIT':
      return error.decision.limit === 1
        ? copy.activeTreeLimitOne
        : i18n.fill(copy.activeTreeLimit, { limit: error.decision.limit });
    case 'VISIBLE_BRANCH_LIMIT':
      return i18n.fill(copy.visibleBranchLimit, { limit: error.decision.limit });
    default:
      return undefined;
  }
}

export async function restoreTreeWithFeedback(
  tree: Tree,
  trees: TreesRepo,
  i18n: I18nService,
  toast: ToastService,
): Promise<boolean> {
  try {
    await trees.restore(tree);
    return true;
  } catch (error) {
    toast.show({ message: forestQuotaMessage(i18n, error) ?? i18n.t().familia.errors.unknown });
    return false;
  }
}
