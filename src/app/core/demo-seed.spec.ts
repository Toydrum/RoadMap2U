import { describe, expect, it, vi } from 'vitest';
import { createFreeAccessSummary, PREPAYMENT_PLAN_CATALOG } from './api/contracts';
import { createMockDemoPremiumAccessSummary } from './api/mock-seed';
import { preflightSeed } from './access/quota-policy';
import { onLocalWrite, type DbChangeMessage } from './db/broadcast';
import {
  isExplicitMockDemoEnvironment,
  maybeSeedDemoForest,
  prepareDemoSeed,
  type DemoSeedPorts,
} from './demo-seed';

const NOW = 1_800_000_000_000;

function ports(overrides: Partial<DemoSeedPorts> = {}): DemoSeedPorts {
  return {
    hasLocalData: () => false,
    assertSeed: vi.fn(),
    replaceIfEmpty: vi.fn(async () => true),
    resetTrees: vi.fn(),
    resetNodes: vi.fn(),
    resetCheckins: vi.fn(),
    resetSessions: vi.fn(),
    resetHarvests: vi.fn(),
    resetPreserves: vi.fn(),
    patchSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('commercial demo seed', () => {
  it('is enabled only by explicit local mock configuration, never by an AWS stage', () => {
    expect(isExplicitMockDemoEnvironment({ backend: 'mock', stage: 'local' })).toBe(true);
    expect(isExplicitMockDemoEnvironment({ backend: 'aws', stage: 'local' })).toBe(false);
    expect(isExplicitMockDemoEnvironment({ backend: 'mock', stage: 'dev' })).toBe(false);
    expect(isExplicitMockDemoEnvironment({ backend: 'mock', stage: 'test' })).toBe(false);
    expect(isExplicitMockDemoEnvironment({ backend: 'mock', stage: 'prod' })).toBe(false);
  });

  it('migrates the fixture first and requires a canonical bounded Premium summary', () => {
    const prepared = prepareDemoSeed();
    const premium = createMockDemoPremiumAccessSummary(NOW);
    const free = createFreeAccessSummary(NOW);

    expect(prepared.trees.filter((tree) => tree.archivedAt === null)).toHaveLength(4);
    expect(
      prepared.trees.every(
        (tree) =>
          typeof tree.heartId === 'string' &&
          prepared.nodes.some(
            (node) => node.id === tree.heartId && node.treeId === tree.id && node.parentId === null,
          ),
      ),
    ).toBe(true);
    expect(premium).toMatchObject({
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
      limits: PREPAYMENT_PLAN_CATALOG.plans.premium.limits,
      capabilities: PREPAYMENT_PLAN_CATALOG.plans.premium.capabilities,
      revision: 1,
      nextRecomputeAt: null,
      offlineValidUntil: NOW + 24 * 60 * 60 * 1000,
    });
    expect(
      preflightSeed(
        { trees: [], nodes: [], access: free, leaseState: 'valid' },
        prepared.trees,
        prepared.nodes,
      ),
    ).toMatchObject({ allowed: false, reason: 'ACTIVE_TREE_LIMIT', projected: 4 });
    expect(
      preflightSeed(
        { trees: [], nodes: [], access: premium, leaseState: 'valid' },
        prepared.trees,
        prepared.nodes,
      ),
    ).toMatchObject({ allowed: true });
  });

  it('runs one aggregate preflight and publishes resets only after one replacement commits', async () => {
    let release!: () => void;
    const seedPorts = ports({
      replaceIfEmpty: vi.fn(
        () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
      ),
    });
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    const pending = maybeSeedDemoForest({
      search: '?seed=demo',
      environment: { backend: 'mock', stage: 'local' },
      now: NOW,
      ports: seedPorts,
    });
    await vi.waitFor(() => expect(seedPorts.replaceIfEmpty).toHaveBeenCalledTimes(1));

    expect(seedPorts.assertSeed).toHaveBeenCalledTimes(1);
    expect(seedPorts.assertSeed).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({
        access: expect.objectContaining({ effectivePlanKey: 'premium' }),
        leaseState: 'valid',
      }),
    );
    expect(seedPorts.resetTrees).not.toHaveBeenCalled();
    expect(seedPorts.patchSettings).not.toHaveBeenCalled();
    expect(messages).toEqual([]);

    release();
    await expect(pending).resolves.toBe(true);

    expect(seedPorts.resetTrees).toHaveBeenCalledOnce();
    expect(seedPorts.resetNodes).toHaveBeenCalledOnce();
    expect(seedPorts.resetCheckins).toHaveBeenCalledOnce();
    expect(seedPorts.resetSessions).toHaveBeenCalledOnce();
    expect(seedPorts.resetHarvests).toHaveBeenCalledOnce();
    expect(seedPorts.resetPreserves).toHaveBeenCalledOnce();
    expect(seedPorts.patchSettings).toHaveBeenCalledOnce();
    expect(messages).toHaveLength(6);
    expect(messages.every((message) => message.reset === true)).toBe(true);
    expect(new Set(messages.map((message) => message.mutationGroupId)).size).toBe(1);
    stop();
  });

  it('does not preflight or mutate for non-mock stages, non-exact queries, or lived-in stores', async () => {
    for (const input of [
      {
        search: '?seed=demo',
        environment: { backend: 'mock' as const, stage: 'prod' },
        ports: ports(),
      },
      {
        search: '?notseed=demo',
        environment: { backend: 'mock' as const, stage: 'local' },
        ports: ports(),
      },
      {
        search: '?seed=demo',
        environment: { backend: 'mock' as const, stage: 'local' },
        ports: ports({ hasLocalData: () => true }),
      },
    ]) {
      await expect(maybeSeedDemoForest({ ...input, now: NOW })).resolves.toBe(false);
      expect(input.ports.assertSeed).not.toHaveBeenCalled();
      expect(input.ports.replaceIfEmpty).not.toHaveBeenCalled();
      expect(input.ports.resetTrees).not.toHaveBeenCalled();
    }
  });

  it('leaves every signal and broadcast untouched when replacement aborts', async () => {
    const failure = new Error('seed transaction abort');
    const seedPorts = ports({
      replaceIfEmpty: vi.fn(async () => Promise.reject(failure)),
    });
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    await expect(
      maybeSeedDemoForest({
        search: '?seed=demo',
        environment: { backend: 'mock', stage: 'local' },
        now: NOW,
        ports: seedPorts,
      }),
    ).rejects.toBe(failure);

    expect(seedPorts.assertSeed).toHaveBeenCalledOnce();
    expect(seedPorts.resetTrees).not.toHaveBeenCalled();
    expect(seedPorts.patchSettings).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    stop();
  });

  it('does not reach replacement or memory when aggregate seed preflight rejects', async () => {
    const denial = new Error('ACTIVE_TREE_LIMIT');
    const seedPorts = ports({
      assertSeed: vi.fn(() => {
        throw denial;
      }),
    });

    await expect(
      maybeSeedDemoForest({
        search: '?seed=demo',
        environment: { backend: 'mock', stage: 'local' },
        now: NOW,
        ports: seedPorts,
      }),
    ).rejects.toBe(denial);

    expect(seedPorts.assertSeed).toHaveBeenCalledOnce();
    expect(seedPorts.replaceIfEmpty).not.toHaveBeenCalled();
    expect(seedPorts.resetTrees).not.toHaveBeenCalled();
    expect(seedPorts.patchSettings).not.toHaveBeenCalled();
  });

  it('yields to a row created by another tab before the conditional transaction', async () => {
    const seedPorts = ports({ replaceIfEmpty: vi.fn(async () => false) });
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    await expect(
      maybeSeedDemoForest({
        search: '?seed=demo',
        environment: { backend: 'mock', stage: 'local' },
        now: NOW,
        ports: seedPorts,
      }),
    ).resolves.toBe(false);

    expect(seedPorts.assertSeed).toHaveBeenCalledOnce();
    expect(seedPorts.replaceIfEmpty).toHaveBeenCalledOnce();
    expect(seedPorts.resetTrees).not.toHaveBeenCalled();
    expect(seedPorts.patchSettings).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
    stop();
  });
});
