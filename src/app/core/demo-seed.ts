import {
  CheckIn,
  Harvest,
  Preserve,
  SCHEMA_VERSION,
  Settings,
  TimerSession,
  Tree,
  TreeNode,
  harvestIdFor,
} from './db/schema';
import type { AccessSummary } from './api/contracts';
import { createMockDemoPremiumAccessSummary } from './api/mock-seed';
import { broadcastMutation } from './db/broadcast';
import type { StoreName } from './db/idb';
import { migrateForestRecords } from './db/migrations';
import { dayOf } from './time';

/**
 * Demo forest for `?seed=demo`: fixed ids so routes are predictable
 * (/tree/demo-guitar), a bit of every status, one branched story.
 * Loaded only when the store is empty — never touches real data.
 */

const now = Date.now();
const day = 86_400_000;

/** Yesterday — so demos showcase the gentle date-review conversation. */
const yesterday = dayOf(now - day);

function base(id: string, offsetDays: number) {
  return {
    id,
    createdAt: now - offsetDays * day,
    updatedAt: now - offsetDays * day,
    rev: 1,
    deletedAt: null,
  };
}

export const DEMO_TREES: Tree[] = [
  {
    ...base('demo-guitar', 40),
    name: 'Aprender guitarra',
    accent: 'moss',
    order: 10,
    currentNodeId: 'demo-g-first-song',
    heartId: 'demo-g-root',
    archivedAt: null,
  },
  {
    ...base('demo-health', 30),
    name: 'Cuidarme',
    accent: 'rose',
    order: 20,
    currentNodeId: null,
    heartId: 'demo-h-root',
    archivedAt: null,
  },
  {
    ...base('demo-work', 20),
    name: 'Proyecto personal',
    accent: 'sky',
    order: 30,
    currentNodeId: null,
    heartId: 'demo-w-root',
    archivedAt: null,
  },
  {
    ...base('demo-seedling', 10),
    name: 'Idea nueva',
    accent: 'clay',
    order: 40,
    currentNodeId: null,
    heartId: 'demo-s-root',
    archivedAt: null,
  },
  // A CLOSED chapter (archived — never shows in the meadow): it feeds the
  // showcase elixir, and the backfill mints its fruits like any lived-in
  // device (fruit survives archive — «nada se gasta»).
  {
    ...base('demo-huerto', 60),
    name: 'Mi huerto de verano',
    accent: 'sand',
    order: 50,
    currentNodeId: null,
    heartId: 'demo-o-root',
    archivedAt: now - 6 * day,
  },
];

function node(
  id: string,
  treeId: string,
  parentId: string | null,
  title: string,
  status: TreeNode['status'],
  order: number,
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    ...base(id, 25),
    treeId,
    parentId,
    title,
    note: '',
    status,
    order,
    targetDate: null,
    achievedAt: status === 'achieved' ? now - 3 * day : null,
    branchedAt: status === 'branched' ? now - 6 * day : null,
    origin: 'planned',
    archivedAt: null,
    ...extra,
  };
}

export const DEMO_NODES: TreeNode[] = [
  // Guitar tree — a real story: roots, blooms, a branch point with alternatives
  node('demo-g-root', 'demo-guitar', null, 'Tocar guitarra', 'growing', 10),
  node('demo-g-buy', 'demo-guitar', 'demo-g-root', 'Conseguir una guitarra', 'achieved', 10),
  node('demo-g-chords', 'demo-guitar', 'demo-g-root', 'Primeros 4 acordes', 'achieved', 20, {
    note: 'El Fa me costó dos semanas — y salió.',
  }),
  node('demo-g-daily', 'demo-guitar', 'demo-g-root', 'Practicar diario 30 min', 'branched', 30),
  node('demo-g-mini', 'demo-guitar', 'demo-g-daily', '10 min al despertar', 'growing', 10, {
    origin: 'branch',
    note: 'Con la guitarra a la vista es más fácil.',
    trigger: 'Cuando me sirva el café de la mañana',
  }),
  node('demo-g-weekend', 'demo-guitar', 'demo-g-daily', 'Sesión larga los sábados', 'seed', 20, {
    origin: 'branch',
  }),
  node(
    'demo-g-first-song',
    'demo-guitar',
    'demo-g-chords',
    'Mi primera canción completa',
    'growing',
    10,
    {
      updatedAt: now - 0.3 * day, // freshest — leads the destination shortcuts
      estimateMin: 30, // «brújula del tiempo» fixture
    },
  ),
  node('demo-g-record', 'demo-guitar', 'demo-g-first-song', 'Grabarme y escucharme', 'seed', 10, {
    priority: 'shade', // «a la sombra» fixture — yields the ambient turn
    estimateMin: 10,
  }),
  // «La espiral» fixture (0.0.104): a single-act ritual leaf — wears the
  // star-dust spiral on the canvas and turns in «Las espirales de hoy».
  node('demo-g-tune', 'demo-guitar', 'demo-g-root', 'Afinarla un minutito', 'seed', 40, {
    repeats: 'daily',
    repeatsDaily: true,
    repeatsSetAt: now - 4 * day,
  }),

  // Health tree — gentler, smaller
  node('demo-h-root', 'demo-health', null, 'Sentirme mejor', 'growing', 10),
  node('demo-h-walk', 'demo-health', 'demo-h-root', 'Caminar 3 veces por semana', 'growing', 10, {
    targetDate: yesterday,
    updatedAt: now - 1.8 * day,
  }),
  node('demo-h-sleep', 'demo-health', 'demo-h-root', 'Dormir antes de las 12', 'resting', 20),
  node('demo-h-water', 'demo-health', 'demo-h-walk', 'Llevar botella de agua', 'achieved', 10),
  // «Las piedritas» fixture (0.0.103): a classic sendero — the almanaque
  // walks it as «el caminito de hoy»; the first stone bloomed TODAY (post-
  // cadence, so the sweep resets it tomorrow — live status = done today).
  node('demo-h-ritual', 'demo-health', 'demo-h-root', 'Mi ritual de la mañana', 'growing', 30, {
    flow: 'steps',
    repeats: 'daily',
    repeatsDaily: true,
    repeatsSetAt: now - 5 * day,
    updatedAt: now - 0.6 * day,
  }),
  node('demo-h-r1', 'demo-health', 'demo-h-ritual', 'Tomar un vaso de agua', 'achieved', 10, {
    achievedAt: now,
  }),
  node('demo-h-r2', 'demo-health', 'demo-h-ritual', 'Abrir la ventana un momento', 'seed', 20),
  node(
    'demo-h-r3',
    'demo-health',
    'demo-h-ritual',
    'Escribir una línea de cómo amanezco',
    'seed',
    30,
  ),

  // Work tree — young, with one branch asleep long enough to appear
  // in the trail's "Ramas dormidas" section (dormant = 30+ quiet days).
  // NOTE: no second trigger fixture here on purpose — a fresher twig would
  // outrank demo-g-mini's and change Ahora's showcased suggestion (it broke
  // verify-ahora/priority when tried in 0.0.106).
  node('demo-w-root', 'demo-work', null, 'Lanzar mi proyecto', 'seed', 10, {
    updatedAt: now - 1.2 * day,
  }),
  node(
    'demo-w-idea',
    'demo-work',
    'demo-w-root',
    'Aterrizar la idea en una página',
    'growing',
    10,
    {
      createdAt: now - 45 * day,
      updatedAt: now - 45 * day,
      priority: 'sunlit', // «a pleno sol» fixture — standing light, below twigs
    },
  ),
  // Two bloomed pasitos — their fruits live SEALED in the showcase jam
  // (DEMO_PRESERVES), so the demo pantry has an alacena from minute one.
  node('demo-w-name', 'demo-work', 'demo-w-root', 'Elegir el nombre', 'achieved', 20, {
    achievedAt: now - 8 * day,
  }),
  node('demo-w-domain', 'demo-work', 'demo-w-root', 'Apartar el dominio', 'achieved', 30, {
    achievedAt: now - 8 * day,
  }),

  // Single-branch baby tree (sapling rendering check). Deliberately the ONE
  // fruitless tree — verify-undo archives it without tripping the elixir.
  node('demo-s-root', 'demo-seedling', null, 'Explorar esta idea', 'seed', 10),

  // The closed chapter behind the elixir (archived tree — meadow never
  // shows it; the register and the brindis still savor its fruits).
  node('demo-o-root', 'demo-huerto', null, 'Cuidar mi huerto', 'growing', 10),
  node(
    'demo-o-tomates',
    'demo-huerto',
    'demo-o-root',
    'Cosechar los primeros jitomates',
    'achieved',
    10,
    { achievedAt: now - 9 * day },
  ),
  node('demo-o-macetas', 'demo-huerto', 'demo-o-root', 'Armar las macetas', 'achieved', 20, {
    achievedAt: now - 20 * day,
  }),
];

/**
 * The showcase conservería (0.0.106 «el escaparate»): one sealed jam with a
 * premio, one promised jar mid-fill, one farewell elixir. Backfill mints the
 * FRESH fruits (it skips ids that already exist and never sets homes), so
 * only the HOMED rows are seeded here — same deterministic 'h:'+nodeId ids.
 */
function fruit(
  nodeId: string,
  treeId: string,
  treeName: string,
  accent: Tree['accent'],
  title: string,
  harvestedAt: number,
  preserveId: string,
): Harvest {
  return {
    ...base(harvestIdFor(nodeId), 8),
    nodeId,
    treeId,
    treeName,
    accent,
    title,
    harvestedAt,
    preserveId,
  };
}

export const DEMO_HARVESTS: Harvest[] = [
  fruit(
    'demo-w-name',
    'demo-work',
    'Proyecto personal',
    'sky',
    'Elegir el nombre',
    now - 8 * day,
    'demo-jam-1',
  ),
  fruit(
    'demo-w-domain',
    'demo-work',
    'Proyecto personal',
    'sky',
    'Apartar el dominio',
    now - 8 * day,
    'demo-jam-1',
  ),
  fruit(
    'demo-h-water',
    'demo-health',
    'Cuidarme',
    'rose',
    'Llevar botella de agua',
    now - 3 * day,
    'demo-promise-1',
  ),
];

export const DEMO_PRESERVES: Preserve[] = [
  {
    ...base('demo-jam-1', 4),
    kind: 'mermelada',
    name: 'Mermelada de los primeros pasos',
    madeAt: now - 4 * day,
    accent: 'sky',
    tint: '#79a8cf',
    tintEdge: '#527ea5',
    size: 'frasquito',
    premio: 'una tarde de películas, sin culpa',
    savedFor: null,
    openedAt: null,
    sealedAt: now - 4 * day,
  },
  {
    ...base('demo-promise-1', 2),
    kind: 'mermelada',
    name: 'Para celebrar mi proyecto',
    madeAt: now - 2 * day,
    accent: null,
    tint: '#b9a3d4',
    tintEdge: '#8f7ab0',
    size: 'frasco',
    premio: 'un libro nuevo, elegido sin prisa',
    savedFor: null,
    openedAt: null,
    plannedAt: now - 2 * day,
    sealedAt: null,
  },
  {
    ...base('demo-elixir-1', 6),
    kind: 'elixir',
    name: 'Mi huerto de verano',
    madeAt: now - 6 * day,
    accent: 'sand',
    tint: '#d9b26a',
    tintEdge: '#b78f4a',
    openedAt: null,
    carry: 'que cuidar algo vivo también me cuida a mí',
    treeId: 'demo-huerto',
  },
];

export const DEMO_CHECKINS: CheckIn[] = [
  {
    ...base('demo-checkin-1', 1),
    feeling: 'calm',
    note: 'Un día tranquilo',
    treeId: 'demo-guitar',
    nodeId: 'demo-g-first-song',
  },
  {
    ...base('demo-checkin-2', 3),
    feeling: 'foggy',
    note: 'La niebla también pasa',
    treeId: null,
    nodeId: null,
  },
];

export const DEMO_SESSIONS: TimerSession[] = [
  {
    ...base('demo-session-1', 2),
    nodeId: 'demo-g-first-song',
    startedAt: now - 2 * day,
    plannedMinutes: 25,
    endedAt: now - 2 * day + 22 * 60_000,
    note: '',
  },
];

export const DEMO_SETTINGS_PATCH: Partial<Settings> = {
  lastCheckInAt: now,
  onboarded: true,
  // The showcase trees are backdated (40d) — without this stamp a fresh
  // demo would open straight into the ~30-day backup offer.
  lastBackupNudgeAt: now,
};

export interface DemoSeedEnvironment {
  readonly backend: string;
  readonly stage: string;
}

export function isExplicitMockDemoEnvironment(environment: DemoSeedEnvironment): boolean {
  return environment.backend === 'mock' && environment.stage === 'local';
}

export interface PreparedDemoSeed {
  readonly trees: Tree[];
  readonly nodes: TreeNode[];
  readonly checkins: CheckIn[];
  readonly sessions: TimerSession[];
  readonly harvests: Harvest[];
  readonly preserves: Preserve[];
}

/** The same deterministic schema pipeline used by live storage and backup
 * import (including v12->v13 inputs) runs before quota sees the showcase. */
export function prepareDemoSeed(): PreparedDemoSeed {
  const forest = migrateForestRecords({ trees: DEMO_TREES, nodes: DEMO_NODES }, SCHEMA_VERSION);
  return {
    ...forest,
    checkins: [...DEMO_CHECKINS],
    sessions: [...DEMO_SESSIONS],
    harvests: [...DEMO_HARVESTS],
    preserves: [...DEMO_PRESERVES],
  };
}

export interface DemoSeedEntry {
  readonly store: StoreName;
  readonly rows: unknown[];
}

export interface DemoSeedPorts {
  hasLocalData(): boolean;
  assertSeed(
    trees: readonly Tree[],
    nodes: readonly TreeNode[],
    context: { readonly access: AccessSummary; readonly leaseState: 'valid' },
  ): void;
  replaceIfEmpty(entries: DemoSeedEntry[]): Promise<boolean>;
  resetTrees(rows: Tree[]): void;
  resetNodes(rows: TreeNode[]): void;
  resetCheckins(rows: CheckIn[]): void;
  resetSessions(rows: TimerSession[]): void;
  resetHarvests(rows: Harvest[]): void;
  resetPreserves(rows: Preserve[]): void;
  patchSettings(patch: Partial<Settings>): Promise<void>;
}

export interface MaybeSeedDemoOptions {
  readonly search: string;
  readonly environment: DemoSeedEnvironment;
  readonly now?: number;
  readonly ports: DemoSeedPorts;
}

/** Explicit mock-only showcase. One aggregate preflight precedes one
 * cross-store replacement; signals and broadcasts publish only afterward. */
export async function maybeSeedDemoForest(options: MaybeSeedDemoOptions): Promise<boolean> {
  if (new URLSearchParams(options.search).get('seed') !== 'demo') return false;
  if (!isExplicitMockDemoEnvironment(options.environment)) return false;
  if (options.ports.hasLocalData()) return false;

  const prepared = prepareDemoSeed();
  const access = createMockDemoPremiumAccessSummary(options.now ?? Date.now());
  options.ports.assertSeed(prepared.trees, prepared.nodes, {
    access,
    leaseState: 'valid',
  });

  const committed = await options.ports.replaceIfEmpty([
    { store: 'trees', rows: prepared.trees },
    { store: 'nodes', rows: prepared.nodes },
    { store: 'checkins', rows: prepared.checkins },
    { store: 'sessions', rows: prepared.sessions },
    { store: 'harvests', rows: prepared.harvests },
    { store: 'preserves', rows: prepared.preserves },
  ]);
  if (!committed) return false;

  options.ports.resetTrees(prepared.trees);
  options.ports.resetNodes(prepared.nodes);
  options.ports.resetCheckins(prepared.checkins);
  options.ports.resetSessions(prepared.sessions);
  options.ports.resetHarvests(prepared.harvests);
  options.ports.resetPreserves(prepared.preserves);

  broadcastMutation([
    { store: 'trees', ids: prepared.trees.map((row) => row.id), reset: true },
    { store: 'nodes', ids: prepared.nodes.map((row) => row.id), reset: true },
    { store: 'checkins', ids: prepared.checkins.map((row) => row.id), reset: true },
    { store: 'sessions', ids: prepared.sessions.map((row) => row.id), reset: true },
    { store: 'harvests', ids: prepared.harvests.map((row) => row.id), reset: true },
    { store: 'preserves', ids: prepared.preserves.map((row) => row.id), reset: true },
  ]);
  await options.ports.patchSettings(DEMO_SETTINGS_PATCH);
  return true;
}
