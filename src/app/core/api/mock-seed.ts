import { preflightSeed } from '../access/quota-policy';
import { migrateForestRecords } from '../db/migrations';
import { SCHEMA_VERSION, Tree, TreeNode } from '../db/schema';
import {
  ACCESS_OFFLINE_LEASE_MS,
  PREPAYMENT_PLAN_CATALOG,
  createFreeAccessSummary,
  type AccessSummary,
  type SyncStore,
} from './contracts';
import {
  MockCodeRow,
  MockCredentialRow,
  MockFriendshipRow,
  MockGuardianLinkRow,
  MockRecordRow,
  MockUserRow,
  mockReplaceAllRaw,
  recordKey,
  type MockReplacementEntry,
} from './mock-cloud';

/**
 * The demo family — deterministic fixtures (fixed ids, fixed codes, fixed
 * passwords; rule 4) so every device can rehearse the whole account story
 * without AWS:
 *
 *   rocio  · Rocío · adult guardian of Nico and Val · password Bosque123
 *   nico   · Nico  · minor, social OFF, temp password Semilla1! → the
 *                    first-login new-password challenge
 *   val    · Val   · minor, social ON, already friends with Ámbar
 *   ambar  · Ámbar · adult, the lush forest worth visiting · Bosque123
 *
 * Sign-up confirmation code is always 123456. Codes/passwords being
 * deterministic is a MOCK property — the real backend uses crypto RNG.
 */

const now = Date.now();
const day = 86_400_000;

/** Explicit entitlement used only by the local four-tree visual showcase.
 * It is never cached as account access and is unreachable in AWS stages. */
export function createMockDemoPremiumAccessSummary(at: number = Date.now()): AccessSummary {
  return {
    effectivePlanKey: 'premium',
    catalogVersion: PREPAYMENT_PLAN_CATALOG.version,
    status: 'active',
    activeSources: [
      {
        kind: 'sponsored',
        sourceId: 'mock-demo-four-tree',
        planKey: 'premium',
        validUntil: null,
      },
    ],
    limits: { ...PREPAYMENT_PLAN_CATALOG.plans.premium.limits },
    capabilities: { ...PREPAYMENT_PLAN_CATALOG.plans.premium.capabilities },
    usage: { activeTrees: 0, visibleBranchesByTree: {} },
    revision: 1,
    nextRecomputeAt: null,
    offlineValidUntil: at + ACCESS_OFFLINE_LEASE_MS,
  };
}

export const MOCK_USERS: MockUserRow[] = [
  { userId: 'mock-parent', username: 'rocio', displayName: 'Rocío', accountType: 'adult', socialEnabled: true, createdAt: now - 90 * day, email: 'rocio@demo.bosque' },
  { userId: 'mock-child', username: 'nico', displayName: 'Nico', accountType: 'minor', socialEnabled: false, createdAt: now - 30 * day, email: null },
  { userId: 'mock-teen', username: 'val', displayName: 'Val', accountType: 'minor', socialEnabled: true, createdAt: now - 60 * day, email: null },
  { userId: 'mock-friend', username: 'ambar', displayName: 'Ámbar', accountType: 'adult', socialEnabled: true, createdAt: now - 120 * day, email: 'ambar@demo.bosque' },
];

export const MOCK_CREDENTIALS: MockCredentialRow[] = [
  { username: 'rocio', userId: 'mock-parent', password: 'Bosque123', mustChangePassword: false, pendingConfirm: false },
  { username: 'nico', userId: 'mock-child', password: 'Semilla1!', mustChangePassword: true, pendingConfirm: false },
  { username: 'val', userId: 'mock-teen', password: 'Bosque123', mustChangePassword: false, pendingConfirm: false },
  { username: 'ambar', userId: 'mock-friend', password: 'Bosque123', mustChangePassword: false, pendingConfirm: false },
];

export const MOCK_GUARDIAN_LINKS: MockGuardianLinkRow[] = [
  { linkId: 'link-rocio-nico', guardianId: 'mock-parent', minorId: 'mock-child', kind: 'created', createdAt: now - 30 * day },
  { linkId: 'link-rocio-val', guardianId: 'mock-parent', minorId: 'mock-teen', kind: 'created', createdAt: now - 60 * day },
];

export const MOCK_FRIENDSHIPS: MockFriendshipRow[] = [
  { friendshipId: 'fr-val-ambar', userA: 'mock-teen', userB: 'mock-friend', createdAt: now - 20 * day },
];

export const MOCK_CODES: MockCodeRow[] = [
  { code: 'MBRD2468', kind: 'friend', userId: 'mock-friend', minorId: null, expiresAt: now + 7 * day },
  { code: 'VLTN1357', kind: 'friend', userId: 'mock-teen', minorId: null, expiresAt: now + 7 * day },
];

// ── Cloud forests ───────────────────────────────────────────────────────────

function base(id: string, offsetDays: number) {
  return {
    id,
    createdAt: now - offsetDays * day,
    updatedAt: now - offsetDays * day,
    rev: 1,
    deletedAt: null,
  };
}

function tree(id: string, heartId: string, name: string, accent: Tree['accent'], order: number, offsetDays: number): Tree {
  return { ...base(id, offsetDays), name, accent, order, currentNodeId: null, heartId, archivedAt: null };
}

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
    ...base(id, 15),
    treeId,
    parentId,
    title,
    note: '',
    status,
    order,
    targetDate: null,
    achievedAt: status === 'achieved' ? now - 4 * day : null,
    branchedAt: status === 'branched' ? now - 8 * day : null,
    origin: 'planned',
    archivedAt: null,
    ...extra,
  };
}

const FORESTS: { ownerId: string; trees: Tree[]; nodes: TreeNode[] }[] = [
  {
    ownerId: 'mock-parent',
    trees: [
      tree('rocio-huerto', 'rocio-h-root', 'Huerto en el balcón', 'moss', 10, 80),
      tree('rocio-lectura', 'rocio-l-root', 'Leer más seguido', 'sand', 20, 50),
    ],
    nodes: [
      node('rocio-h-root', 'rocio-huerto', null, 'Un huerto que dé de comer', 'growing', 10),
      node('rocio-h-macetas', 'rocio-huerto', 'rocio-h-root', 'Conseguir macetas hondas', 'achieved', 10),
      node('rocio-h-jitomate', 'rocio-huerto', 'rocio-h-root', 'Jitomates cherry', 'growing', 20),
      node('rocio-l-root', 'rocio-lectura', null, 'Leer 10 min por noche', 'growing', 10),
      node('rocio-l-mesita', 'rocio-lectura', 'rocio-l-root', 'Libro en la mesita, celular fuera', 'achieved', 10, { note: 'La clave fue el cargador en la cocina.' }),
    ],
  },
  {
    ownerId: 'mock-child',
    trees: [tree('nico-bici', 'nico-b-root', 'Andar en bici sin rueditas', 'sky', 10, 25)],
    nodes: [
      node('nico-b-root', 'nico-bici', null, 'Rodar solo hasta el parque', 'growing', 10),
      node('nico-b-equilibrio', 'nico-bici', 'nico-b-root', 'Practicar equilibrio en el pasto', 'achieved', 10),
      node('nico-b-frenar', 'nico-bici', 'nico-b-root', 'Aprender a frenar suave', 'growing', 20),
    ],
  },
  {
    ownerId: 'mock-teen',
    trees: [tree('val-banda', 'val-b-root', 'Tocar en una banda', 'lavender', 10, 55)],
    nodes: [
      node('val-b-root', 'val-banda', null, 'Subirme a un escenario', 'growing', 10),
      node('val-b-bajo', 'val-banda', 'val-b-root', 'Clases de bajo', 'growing', 10),
      node('val-b-cover', 'val-banda', 'val-b-bajo', 'Sacar mi primer cover', 'achieved', 10),
      node('val-b-amigos', 'val-banda', 'val-b-root', 'Encontrar con quién tocar', 'seed', 20),
    ],
  },
  {
    ownerId: 'mock-friend',
    trees: [
      tree('ambar-ceramica', 'ambar-c-root', 'Cerámica', 'clay', 10, 110),
      tree('ambar-jardin', 'ambar-j-root', 'Jardín de lluvia', 'pine', 20, 70),
    ],
    nodes: [
      node('ambar-c-root', 'ambar-ceramica', null, 'Vivir del barro', 'growing', 10),
      node('ambar-c-torno', 'ambar-ceramica', 'ambar-c-root', 'Dominar el torno', 'branched', 10),
      node('ambar-c-centrar', 'ambar-ceramica', 'ambar-c-torno', 'Centrar sin pelear', 'achieved', 10, { origin: 'branch' }),
      node('ambar-c-cilindro', 'ambar-ceramica', 'ambar-c-torno', 'Cilindros parejos', 'achieved', 20, { origin: 'branch' }),
      node('ambar-c-esmalte', 'ambar-ceramica', 'ambar-c-root', 'Mis propios esmaltes', 'growing', 20),
      node('ambar-c-celadon', 'ambar-ceramica', 'ambar-c-esmalte', 'Un celadón verde niebla', 'achieved', 10),
      node('ambar-c-venta', 'ambar-ceramica', 'ambar-c-root', 'Primera venta en mercadito', 'achieved', 30),
      node('ambar-c-horno', 'ambar-ceramica', 'ambar-c-root', 'Horno propio algún día', 'seed', 40),
      node('ambar-j-root', 'ambar-jardin', null, 'Que la lluvia se quede', 'growing', 10),
      node('ambar-j-zanja', 'ambar-jardin', 'ambar-j-root', 'Trazar la zanja', 'achieved', 10),
      node('ambar-j-piedras', 'ambar-jardin', 'ambar-j-root', 'Juntar piedras de río', 'achieved', 20),
      node('ambar-j-nativas', 'ambar-jardin', 'ambar-j-root', 'Plantas que aguanten charco', 'growing', 30),
    ],
  },
];

export interface PreparedMockForest {
  readonly ownerId: string;
  readonly trees: Tree[];
  readonly nodes: TreeNode[];
}

export interface PreparedMockSeed {
  readonly forests: PreparedMockForest[];
  readonly entries: MockReplacementEntry[];
}

/** Pure preparation boundary: run every owner forest through the shared
 * schema migrator, then make one aggregate Free decision for that owner
 * before any mock-cloud transaction. */
export function prepareMockSeed(): PreparedMockSeed {
  let seq = 0;
  const records: MockRecordRow[] = [];
  const forests: PreparedMockForest[] = [];
  for (const forest of FORESTS) {
    const migrated = migrateForestRecords(
      { trees: forest.trees, nodes: forest.nodes },
      SCHEMA_VERSION,
    );
    const decision = preflightSeed(
      {
        trees: [],
        nodes: [],
        access: createFreeAccessSummary(now),
        leaseState: 'valid',
      },
      migrated.trees,
      migrated.nodes,
    );
    if (!decision.allowed) {
      throw new Error(`mock seed quota violation for ${forest.ownerId}: ${decision.reason}`);
    }
    forests.push({ ownerId: forest.ownerId, ...migrated });
    const push = (store: SyncStore, record: Tree | TreeNode) => {
      seq += 1;
      records.push({
        key: recordKey(forest.ownerId, store, record.id),
        ownerId: forest.ownerId,
        store,
        record,
        seq,
        syncedAt: now,
      });
    };
    for (const t of migrated.trees) push('trees', t);
    for (const n of migrated.nodes) push('nodes', n);
  }

  return {
    forests,
    entries: [
      { store: 'users', rows: MOCK_USERS },
      { store: 'credentials', rows: MOCK_CREDENTIALS },
      { store: 'guardianLinks', rows: MOCK_GUARDIAN_LINKS },
      { store: 'friendships', rows: MOCK_FRIENDSHIPS },
      { store: 'friendRequests', rows: [] },
      { store: 'codes', rows: MOCK_CODES },
      { store: 'records', rows: records },
      {
        store: 'kv',
        rows: [
          { key: 'changeSeq', value: seq },
          { key: 'seeded', value: true },
        ],
      },
    ],
  };
}

export interface MockSeedStorage {
  replace(entries: readonly MockReplacementEntry[]): Promise<void>;
}

/** Writes the whole family once; called by mock-cloud.ready(). */
export async function plantMockSeed(
  storage: MockSeedStorage = { replace: mockReplaceAllRaw },
): Promise<void> {
  const prepared = prepareMockSeed();
  await storage.replace(prepared.entries);
}
