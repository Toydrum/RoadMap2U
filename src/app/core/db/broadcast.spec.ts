import { describe, expect, it } from 'vitest';
import {
  broadcastChange,
  broadcastMutation,
  onLocalWrite,
  type DbChangeMessage,
} from './broadcast';

describe('database mutation groups', () => {
  it('mints a fresh group id for sequential writes over the same records', () => {
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    broadcastChange({ store: 'nodes', ids: ['branch-b', 'branch-a'] });
    broadcastChange({ store: 'nodes', ids: ['branch-a', 'branch-b'] });

    const first = messages[0] as DbChangeMessage & { mutationGroupId?: string };
    const second = messages[1] as DbChangeMessage & { mutationGroupId?: string };
    expect(first.mutationGroupId).toMatch(/^mg-[0-9a-f-]{36}$/);
    expect(second.mutationGroupId).toMatch(/^mg-[0-9a-f-]{36}$/);
    expect(second.mutationGroupId).not.toBe(first.mutationGroupId);
    stop();
  });

  it('preserves one explicit group across the stores of an atomic write', () => {
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    broadcastChange({
      store: 'trees',
      ids: ['tree-a'],
      mutationGroupId: 'tree-with-heart',
    } as DbChangeMessage);
    broadcastChange({
      store: 'nodes',
      ids: ['heart-a'],
      mutationGroupId: 'tree-with-heart',
    } as DbChangeMessage);

    expect(
      messages.map(
        (message) => (message as DbChangeMessage & { mutationGroupId?: string }).mutationGroupId,
      ),
    ).toEqual(['tree-with-heart', 'tree-with-heart']);
    stop();
  });

  it('broadcasts a cross-store transaction under one freshly-minted id', () => {
    const messages: DbChangeMessage[] = [];
    const stop = onLocalWrite((message) => messages.push(message));

    const firstId = broadcastMutation([
      { store: 'preserves', ids: ['jar-a'] },
      { store: 'harvests', ids: ['fruit-a', 'fruit-b'] },
    ]);
    const secondId = broadcastMutation([
      { store: 'preserves', ids: ['jar-a'] },
      { store: 'harvests', ids: ['fruit-a', 'fruit-b'] },
    ]);

    expect(messages.slice(0, 2).every((message) => message.mutationGroupId === firstId)).toBe(true);
    expect(messages.slice(2).every((message) => message.mutationGroupId === secondId)).toBe(true);
    expect(secondId).not.toBe(firstId);
    stop();
  });
});
