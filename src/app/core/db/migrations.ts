import { ExportEnvelope, SCHEMA_VERSION, Tree, TreeNode } from './schema';

type UnknownRecord = Record<string, unknown>;

export interface MigratedForestRecords {
  trees: Tree[];
  nodes: TreeNode[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaVersionOf(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error('malformed schema version');
  }
  const version = value as number;
  if (version > SCHEMA_VERSION) {
    throw new Error('backup from a newer app version');
  }
  return version;
}

function recordList(value: unknown, label: string): UnknownRecord[] {
  if (
    !Array.isArray(value) ||
    value.some((row) => !isRecord(row) || typeof row['id'] !== 'string')
  ) {
    throw new Error(`${label} data is malformed`);
  }
  return value.map((row) => ({ ...row }));
}

/** Missing/non-finite historical sort fields sort last. If both are missing,
 *  the immutable id settles the choice, so every device reaches the same
 *  heart without inventing a timestamp or order. */
function stableNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRoot(a: UnknownRecord, b: UnknownRecord): number {
  const aOrder = stableNumber(a['order']);
  const bOrder = stableNumber(b['order']);
  if (aOrder !== bOrder) return aOrder < bOrder ? -1 : 1;

  const aCreatedAt = stableNumber(a['createdAt']);
  const bCreatedAt = stableNumber(b['createdAt']);
  if (aCreatedAt !== bCreatedAt) return aCreatedAt < bCreatedAt ? -1 : 1;

  return compareText(a['id'] as string, b['id'] as string);
}

function existingHeart(tree: UnknownRecord): string | null | undefined {
  if (!Object.hasOwn(tree, 'heartId')) return undefined;
  const heartId = tree['heartId'];
  if (heartId !== null && (typeof heartId !== 'string' || heartId.length === 0)) {
    throw new Error('tree heartId is malformed');
  }
  return heartId as string | null;
}

/**
 * Pure, non-mutating data-shape migration shared by live IndexedDB and backup
 * import. Structural DB upgrades remain in idb.ts and are deliberately
 * independent from this pipeline.
 */
export function migrateForestRecords(input: unknown, fromVersion: unknown): MigratedForestRecords {
  const version = schemaVersionOf(fromVersion);
  if (!isRecord(input)) throw new Error('forest data is malformed');

  const trees = recordList(input['trees'], 'trees');
  const nodes = recordList(input['nodes'], 'nodes');
  for (const node of nodes) {
    if (typeof node['treeId'] !== 'string') throw new Error('nodes data is malformed');
  }

  if (version === SCHEMA_VERSION) {
    for (const tree of trees) {
      if (existingHeart(tree) === undefined) throw new Error('tree heartId is missing');
    }
    return { trees: trees as unknown as Tree[], nodes: nodes as unknown as TreeNode[] };
  }

  const rootsByTree = new Map<string, UnknownRecord[]>();
  for (const node of nodes) {
    // Match NodesRepo.visible + heartOf exactly at the one-time assignment:
    // archived and tombstoned roots cannot become a legacy heart. Once an id
    // is persisted on v13, later archive/restore never runs this selection
    // again, so that assigned identity remains immutable.
    if (node['parentId'] !== null || node['deletedAt'] != null || node['archivedAt'] != null)
      continue;
    const treeId = node['treeId'] as string;
    const roots = rootsByTree.get(treeId) ?? [];
    roots.push(node);
    rootsByTree.set(treeId, roots);
  }
  for (const roots of rootsByTree.values()) roots.sort(compareRoot);

  const migratedTrees = trees.map((tree) => {
    const assigned = existingHeart(tree);
    if (assigned !== undefined) return tree as unknown as Tree;
    const roots = rootsByTree.get(tree['id'] as string) ?? [];
    return {
      ...tree,
      heartId: (roots[0]?.['id'] as string | undefined) ?? null,
    } as unknown as Tree;
  });

  return { trees: migratedTrees, nodes: nodes as unknown as TreeNode[] };
}

/** Validate and migrate a backup envelope before any disk write. Both the
 * current and pre-rename app ids are intentional permanent import values. */
export function migrateBackupEnvelope(input: unknown): ExportEnvelope {
  if (!isRecord(input)) throw new Error('backup is malformed');
  if (input['app'] !== 'roadmap2u' && input['app'] !== 'rodemap2u') {
    throw new Error('not a RoadMap2U backup');
  }
  const version = schemaVersionOf(input['schemaVersion']);
  if (typeof input['exportedAt'] !== 'string' || !isRecord(input['data'])) {
    throw new Error('backup data is malformed');
  }

  const data = input['data'];
  const forest = migrateForestRecords({ trees: data['trees'], nodes: data['nodes'] }, version);
  const checkins = recordList(data['checkins'], 'checkins');
  const sessions = recordList(data['sessions'], 'sessions');
  const harvests =
    data['harvests'] === undefined ? undefined : recordList(data['harvests'], 'harvests');
  const preserves =
    data['preserves'] === undefined ? undefined : recordList(data['preserves'], 'preserves');
  const settings = data['settings'];
  if (settings !== null && settings !== undefined && !isRecord(settings)) {
    throw new Error('settings data is malformed');
  }

  return {
    ...input,
    schemaVersion: SCHEMA_VERSION,
    data: {
      ...data,
      trees: forest.trees,
      nodes: forest.nodes,
      checkins,
      sessions,
      ...(harvests === undefined ? {} : { harvests }),
      ...(preserves === undefined ? {} : { preserves }),
      settings: (settings ?? null) as ExportEnvelope['data']['settings'],
    },
  } as unknown as ExportEnvelope;
}
