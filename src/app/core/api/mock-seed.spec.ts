import { describe, expect, it, vi } from 'vitest';
import { countQuotaUsage } from '../access/quota-policy';
import { plantMockSeed, prepareMockSeed, type MockSeedStorage } from './mock-seed';

describe('mock cloud seed boundary', () => {
  it('mints a fresh stable instance for every seeded account incarnation', () => {
    const first = prepareMockSeed().entries.find((entry) => entry.store === 'users')
      ?.rows as Array<{
      userId: string;
      accountInstanceId: string;
    }>;
    const second = prepareMockSeed().entries.find((entry) => entry.store === 'users')
      ?.rows as Array<{
      userId: string;
      accountInstanceId: string;
    }>;

    expect(first.every((user) => /^[0-9a-f-]{36}$/.test(user.accountInstanceId))).toBe(true);
    expect(new Set(first.map((user) => user.accountInstanceId)).size).toBe(first.length);
    expect(second.map((user) => user.accountInstanceId)).not.toEqual(
      first.map((user) => user.accountInstanceId),
    );
  });

  it('migrates and validates every owner forest before producing rows', () => {
    const prepared = prepareMockSeed();

    expect(prepared.forests).toHaveLength(4);
    for (const forest of prepared.forests) {
      const usage = countQuotaUsage({ trees: forest.trees, nodes: forest.nodes });
      expect(usage.drift, forest.ownerId).toEqual([]);
      expect(usage.activeTrees, forest.ownerId).toBeLessThanOrEqual(2);
      expect(
        Object.values(usage.visibleBranchesByTree).every((count) => count <= 10),
        forest.ownerId,
      ).toBe(true);
      expect(
        forest.trees.every((tree) =>
          forest.nodes.some(
            (node) => node.id === tree.heartId && node.treeId === tree.id && node.parentId === null,
          ),
        ),
        forest.ownerId,
      ).toBe(true);
    }
  });

  it('commits the whole mock fixture through one atomic replacement port', async () => {
    const replace = vi.fn<MockSeedStorage['replace']>(async () => undefined);
    const storage: MockSeedStorage = { replace };

    await plantMockSeed(storage);

    expect(replace).toHaveBeenCalledTimes(1);
    const entries = replace.mock.calls[0]![0];
    expect(entries.map((entry) => entry.store)).toEqual([
      'users',
      'credentials',
      'guardianLinks',
      'friendships',
      'friendRequests',
      'codes',
      'records',
      'kv',
    ]);
    expect(entries.find((entry) => entry.store === 'kv')?.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'seeded', value: true }),
        expect.objectContaining({ key: 'changeSeq' }),
      ]),
    );
  });
});
