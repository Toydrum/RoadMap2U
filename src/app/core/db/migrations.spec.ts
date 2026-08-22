import { describe, expect, it } from 'vitest';
import { migrateBackupEnvelope, migrateForestRecords } from './migrations';

const baseTree = (id: string, currentNodeId: string | null = null) => ({
  id,
  createdAt: 1,
  updatedAt: 1,
  rev: 1,
  deletedAt: null,
  name: id,
  accent: 'moss',
  order: 10,
  currentNodeId,
  archivedAt: null,
});

const baseNode = (id: string, treeId: string, partial: Record<string, unknown> = {}) => ({
  id,
  createdAt: 1,
  updatedAt: 1,
  rev: 1,
  deletedAt: null,
  treeId,
  parentId: null,
  title: id,
  note: '',
  status: 'seed',
  order: 10,
  targetDate: null,
  achievedAt: null,
  branchedAt: null,
  origin: 'planned',
  archivedAt: null,
  ...partial,
});

const envelope = (
  app: 'roadmap2u' | 'rodemap2u',
  trees: Record<string, unknown>[],
  nodes: Record<string, unknown>[],
) => ({
  app,
  schemaVersion: 12,
  exportedAt: '2026-08-19T00:00:00.000Z',
  data: {
    trees,
    nodes,
    checkins: [],
    sessions: [],
    settings: null,
  },
});

describe('v12 -> v13 forest migration', () => {
  it('chooses exactly one visible root by order, createdAt, then id', () => {
    const tree = baseTree('tree-a', 'keep-current-node');
    const input = {
      trees: [tree],
      nodes: [
        baseNode('deleted-first', tree.id, { order: -100, createdAt: -100, deletedAt: 20 }),
        baseNode('archived-first', tree.id, { order: -90, createdAt: -90, archivedAt: 20 }),
        baseNode('child-first', tree.id, { order: -50, createdAt: -50, parentId: 'someone' }),
        baseNode('root-later', tree.id, { order: 10, createdAt: 20 }),
        baseNode('root-heart', tree.id, { order: 10, createdAt: 10 }),
        baseNode('root-extra', tree.id, { order: 20, createdAt: 1 }),
      ],
    };
    const before = JSON.stringify(input);

    const migrated = migrateForestRecords(input, 12);

    expect(migrated.trees[0].heartId).toBe('root-heart');
    expect(migrated.trees[0].currentNodeId).toBe('keep-current-node');
    expect(migrated.nodes).toEqual(input.nodes);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('breaks exact ties by id and uses a stable last-place fallback for missing order/dates', () => {
    const ordered = baseTree('tree-ordered');
    const missing = baseTree('tree-missing');
    const migrated = migrateForestRecords(
      {
        trees: [ordered, missing],
        nodes: [
          baseNode('z-valid', ordered.id, { order: 4, createdAt: 4 }),
          baseNode('a-valid', ordered.id, { order: 4, createdAt: 4 }),
          baseNode('a-missing', ordered.id, { order: undefined, createdAt: undefined }),
          baseNode('z-missing', missing.id, { order: undefined, createdAt: undefined }),
          baseNode('a-missing', missing.id, { order: undefined, createdAt: undefined }),
        ],
      },
      12,
    );

    expect(migrated.trees.find((tree) => tree.id === ordered.id)?.heartId).toBe('a-valid');
    expect(migrated.trees.find((tree) => tree.id === missing.id)?.heartId).toBe('a-missing');
  });

  it('records null drift when a tree has no non-tombstoned root', () => {
    const tree = baseTree('tree-empty');
    const migrated = migrateForestRecords(
      {
        trees: [tree],
        nodes: [
          baseNode('gone', tree.id, { deletedAt: 99 }),
          baseNode('still-child', tree.id, { parentId: 'gone' }),
        ],
      },
      12,
    );

    expect(migrated.trees[0].heartId).toBeNull();
  });

  it('does not replace a heart already assigned in schema v13 and reruns byte-equivalently', () => {
    const current = {
      trees: [{ ...baseTree('tree-current'), heartId: 'persisted-heart' }],
      nodes: [baseNode('different-root', 'tree-current', { order: -10 })],
    };
    const once = migrateForestRecords(current, 13);
    const twice = migrateForestRecords(once, 13);

    expect(once.trees[0].heartId).toBe('persisted-heart');
    expect(JSON.stringify(once)).toBe(JSON.stringify(current));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

describe('backup migration boundary', () => {
  it('keeps pre-rename rodemap2u schema-12 backups importable through the pure migrator', () => {
    const legacy = envelope(
      'rodemap2u',
      [baseTree('legacy-tree')],
      [baseNode('legacy-heart', 'legacy-tree')],
    );

    const migrated = migrateBackupEnvelope(legacy);

    expect(migrated.app).toBe('rodemap2u');
    expect(migrated.schemaVersion).toBe(13);
    expect(migrated.data.trees[0].heartId).toBe('legacy-heart');
    expect(legacy.schemaVersion).toBe(12);
    expect('heartId' in legacy.data.trees[0]).toBe(false);
  });

  it('fails closed for future, malformed, or falsely-current payloads', () => {
    const valid = envelope('roadmap2u', [baseTree('tree-a')], [baseNode('root-a', 'tree-a')]);

    expect(() => migrateBackupEnvelope({ ...valid, schemaVersion: 14 })).toThrow(/newer/i);
    expect(() => migrateBackupEnvelope({ ...valid, data: { ...valid.data, trees: {} } })).toThrow(
      /malformed/i,
    );
    expect(() =>
      migrateBackupEnvelope({ ...valid, data: { ...valid.data, trees: [{ name: 'no id' }] } }),
    ).toThrow(/malformed/i);
    expect(() =>
      migrateBackupEnvelope({ ...valid, data: { ...valid.data, nodes: [{ treeId: 'tree-a' }] } }),
    ).toThrow(/malformed/i);
    expect(() => migrateBackupEnvelope({ ...valid, schemaVersion: 13 })).toThrow(/heartId/i);
    expect(() => migrateForestRecords({ trees: [], nodes: [] }, Number.NaN)).toThrow(
      /schema version/i,
    );
  });
});
