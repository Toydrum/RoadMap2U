import { beforeEach, describe, expect, it } from 'vitest';
import { MockAuthProvider, parseMockToken } from './mock-auth.provider';
import { MockApiMemoryDb } from '../api/mock-api-test-memory.spec-helper';

const memory = new MockApiMemoryDb();
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: memory.indexedDb });
beforeEach(() => {
  memory.reset();
  memory.seed('kv', 'seeded', { key: 'seeded', value: true });
  localStorage.removeItem('rm2u.mock.idToken');
  memory.seed('users', 'parent', {
    userId: 'parent',
    username: 'parent',
    displayName: 'Parent',
    email: 'parent@example.test',
    accountType: 'adult',
    socialEnabled: false,
    createdAt: 1,
    accountInstanceId: 'parent-instance',
  });
  memory.seed('credentials', 'parent', {
    username: 'parent',
    userId: 'parent',
    password: 'SecureTest123!',
    pendingConfirm: false,
    mustChangePassword: false,
  });
});
describe('mock authorization authentication evidence', () => {
  it('includes confirmed email and login time, and preserves login time on refresh', async () => {
    const provider = new MockAuthProvider();
    expect((await provider.signIn('parent', 'SecureTest123!')).kind).toBe('done');
    const first = parseMockToken((await provider.idToken())!) as any;
    expect(first.email_verified).toBe(true);
    expect(first.auth_time).toBeGreaterThan(Math.floor(Date.now() / 1000) - 10);
    const stale = { ...first, auth_time: first.auth_time - 960 };
    localStorage.setItem('rm2u.mock.idToken', `mock.${btoa(JSON.stringify(stale))}.mock`);
    const refreshed = parseMockToken((await provider.idToken({ forceRefresh: true }))!) as any;
    expect(refreshed.auth_time).toBe(stale.auth_time);
    expect(refreshed.email_verified).toBe(true);
  });
  it('does not mint verified email before signup confirmation', async () => {
    memory.seed('credentials', 'parent', {
      username: 'parent',
      userId: 'parent',
      password: 'SecureTest123!',
      pendingConfirm: true,
      mustChangePassword: false,
    });
    const provider = new MockAuthProvider();
    expect((await provider.signIn('parent', 'SecureTest123!')).kind).toBe('confirmSignUp');
    expect(await provider.idToken()).toBeNull();
    await provider.confirmSignUp('parent', '123456');
    await provider.signIn('parent', 'SecureTest123!');
    expect((parseMockToken((await provider.idToken())!) as any).email_verified).toBe(true);
  });
});
