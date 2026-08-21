import { AuthProvider } from './auth-provider';
import {
  AuthError,
  AuthNext,
  AuthSession,
  passwordMeetsPolicy,
  USERNAME_PATTERN,
} from './auth-types';
import {
  MockCredentialRow,
  MockUserRow,
  mockAccountClosureKey,
  mockGet,
  mockPut,
  simLatency,
  withMockAccountLock,
} from '../api/mock-cloud';

/**
 * Cognito, simulated — same challenges, same error vocabulary, zero network.
 * Deterministic on purpose: the confirmation code is ALWAYS 123456, seeded
 * demo passwords live in mock-seed.ts, and tokens are unsigned JWT-SHAPED
 * strings in localStorage (1 h exp, free "refresh") so the bearer plumbing the
 * real backend needs is rehearsed end to end. Works fully offline.
 */

const TOKEN_KEY = 'rm2u.mock.idToken';
const TOKEN_TTL_MS = 60 * 60 * 1000;
const MOCK_CODE = '123456';

interface MockTokenPayload {
  sub: string;
  username: string;
  /** Absent only on pre-account-instance tokens, which are upgraded once. */
  accountInstanceId?: string;
  'custom:accountType': string;
  iat: number;
  exp: number;
}

interface LiveMockIdentity {
  token: string;
  user: MockUserRow;
}

function mintToken(user: MockUserRow, now = Date.now()): string {
  if (!user.accountInstanceId) throw new AuthError('unknown', 'account instance missing');
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  // ASCII-safe by construction: username is [a-z0-9_], no display text here.
  const payload = btoa(
    JSON.stringify({
      sub: user.userId,
      username: user.username,
      accountInstanceId: user.accountInstanceId,
      'custom:accountType': user.accountType,
      iat: now,
      exp: now + TOKEN_TTL_MS,
    } satisfies MockTokenPayload),
  );
  return `${header}.${payload}.mock`;
}

export function parseMockToken(token: string): MockTokenPayload | null {
  try {
    return JSON.parse(atob(token.split('.')[1])) as MockTokenPayload;
  } catch {
    return null;
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local[0] ?? '?'}***@${domain?.[0] ?? '?'}***`;
}

export class MockAuthProvider implements AuthProvider {
  /** Username mid-newPasswordRequired — in memory only, like Cognito's flow. */
  private pendingChallenge: {
    username: string;
    userId: string;
    accountInstanceId: string;
  } | null = null;
  /** Account incarnation that received the current recovery code. */
  private pendingRecovery: {
    username: string;
    userId: string;
    accountInstanceId: string;
  } | null = null;
  /** Revoked bearer retained in memory only for the matching closure receipt. */
  private closureRetryToken: string | null = null;

  async signIn(username: string, password: string): Promise<AuthNext> {
    await simLatency('auth.signIn');
    const handle = username.trim().toLowerCase();
    const initialCredential = await mockGet<MockCredentialRow>('credentials', handle);
    if (!initialCredential) throw new AuthError('userNotFound');
    if (initialCredential.password !== password) throw new AuthError('wrongCredentials');
    return this.withCredentialMutation(handle, async (credential, user) => {
      if (credential.password !== password) throw new AuthError('wrongCredentials');
      if (credential.pendingConfirm) {
        return {
          kind: 'confirmSignUp',
          username: handle,
          deliveryHint: user.email ? maskEmail(user.email) : null,
        };
      }
      if (credential.mustChangePassword) {
        this.pendingChallenge = {
          username: handle,
          userId: user.userId,
          accountInstanceId: user.accountInstanceId!,
        };
        return { kind: 'newPasswordRequired' };
      }
      return this.establish(user);
    });
  }

  async signUp(input: {
    username: string;
    password: string;
    email: string;
    displayName: string;
  }): Promise<AuthNext> {
    await simLatency('auth.signUp');
    const handle = input.username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(handle)) throw new AuthError('unknown', 'invalid username');
    if (!passwordMeetsPolicy(input.password)) throw new AuthError('passwordPolicy');
    const userId = `u-${handle}`;
    return withMockAccountLock(userId, async () => {
      if (
        (await mockGet<MockCredentialRow>('credentials', handle)) ||
        (await mockGet<MockUserRow>('users', userId))
      ) {
        throw new AuthError('userExists');
      }
      const user: MockUserRow = {
        userId,
        username: handle,
        displayName: input.displayName.trim() || handle,
        accountType: 'adult', // minors never self-sign-up; guardians create them
        socialEnabled: true,
        createdAt: Date.now(),
        email: input.email.trim(),
        accountInstanceId: crypto.randomUUID(),
      };
      await mockPut('users', user);
      await mockPut('credentials', {
        username: handle,
        userId: user.userId,
        password: input.password,
        mustChangePassword: false,
        pendingConfirm: true,
      } satisfies MockCredentialRow);
      return { kind: 'confirmSignUp', username: handle, deliveryHint: maskEmail(user.email!) };
    });
  }

  async confirmSignUp(username: string, code: string): Promise<void> {
    await simLatency('auth.confirmSignUp');
    return this.withCredentialMutation(username, async (credential) => {
      if (code.trim() !== MOCK_CODE) throw new AuthError('codeMismatch');
      await mockPut('credentials', { ...credential, pendingConfirm: false });
    });
  }

  async resendCode(username: string): Promise<void> {
    await simLatency('auth.resendCode');
    const cred = await mockGet<MockCredentialRow>('credentials', username.trim().toLowerCase());
    if (!cred) throw new AuthError('userNotFound');
    // The mock "sends" nothing — the code is always 123456.
  }

  async completeNewPassword(newPassword: string): Promise<AuthNext> {
    await simLatency('auth.completeNewPassword');
    if (!this.pendingChallenge) throw new AuthError('unknown', 'no pending challenge');
    if (!passwordMeetsPolicy(newPassword)) throw new AuthError('passwordPolicy');
    const challenge = this.pendingChallenge;
    return this.withCredentialMutation(
      challenge.username,
      async (credential, user) => {
        await mockPut('credentials', {
          ...credential,
          password: newPassword,
          mustChangePassword: false,
        });
        this.pendingChallenge = null;
        return this.establish(user);
      },
      challenge,
    );
  }

  async forgotPassword(username: string): Promise<{ deliveryHint: string | null }> {
    await simLatency('auth.forgotPassword');
    const handle = username.trim().toLowerCase();
    return this.withCredentialMutation(handle, async (_credential, user) => {
      if (!user.email) {
        // Username-only minors recover through their guardian, never a code.
        throw new AuthError('unknown', 'no recovery email on this account');
      }
      this.pendingRecovery = {
        username: handle,
        userId: user.userId,
        accountInstanceId: user.accountInstanceId!,
      };
      return { deliveryHint: maskEmail(user.email) };
    });
  }

  async confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void> {
    await simLatency('auth.confirmForgotPassword');
    const handle = username.trim().toLowerCase();
    const recovery = this.pendingRecovery;
    if (!recovery || recovery.username !== handle) {
      throw new AuthError('userNotFound');
    }
    return this.withCredentialMutation(
      handle,
      async (credential) => {
        if (code.trim() !== MOCK_CODE) throw new AuthError('codeMismatch');
        if (!passwordMeetsPolicy(newPassword)) throw new AuthError('passwordPolicy');
        await mockPut('credentials', {
          ...credential,
          password: newPassword,
          mustChangePassword: false,
        });
        this.pendingRecovery = null;
      },
      recovery,
    );
  }

  async signOut(): Promise<void> {
    await simLatency('auth.signOut');
    localStorage.removeItem(TOKEN_KEY);
    this.pendingChallenge = null;
    this.pendingRecovery = null;
    this.closureRetryToken = null;
  }

  async currentSession(): Promise<AuthSession | null> {
    const identity = await this.liveIdentity(false);
    return identity ? this.sessionOf(identity.user) : null;
  }

  async idToken(opts?: { forceRefresh?: boolean }): Promise<string | null> {
    return (await this.liveIdentity(opts?.forceRefresh ?? false))?.token ?? null;
  }

  /** Dedicated credential for idempotent DELETE /me retries after closure. */
  async accountClosureCredential(): Promise<string | null> {
    const live = await this.liveIdentity(false);
    if (live) return live.token;

    const token = this.closureRetryToken;
    const payload = token ? parseMockToken(token) : null;
    if (!payload?.accountInstanceId) return null;
    return withMockAccountLock(payload.sub, async () => {
      const key = mockAccountClosureKey(payload.sub, payload.accountInstanceId!);
      const closure = await mockGet<{
        key?: unknown;
        value?: {
          receipt?: { closureId?: unknown; state?: unknown };
          userId?: unknown;
          accountInstanceId?: unknown;
          purgeCompleted?: unknown;
        };
      }>('kv', key);
      const receipt = closure?.value?.receipt;
      const canonical =
        closure?.key === key &&
        closure.value?.userId === payload.sub &&
        closure.value?.accountInstanceId === payload.accountInstanceId &&
        typeof closure.value?.purgeCompleted === 'boolean' &&
        typeof receipt?.closureId === 'string' &&
        receipt.closureId.startsWith('mock:') &&
        receipt.closureId.length > 'mock:'.length &&
        receipt.state === 'completed';
      if (!canonical) {
        this.closureRetryToken = null;
        return null;
      }
      return this.closureRetryToken === token ? token : null;
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Valid identity or null; expired tokens re-mint freely (mock refresh). */
  private async liveIdentity(forceRefresh: boolean): Promise<LiveMockIdentity | null> {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    const payload = parseMockToken(token);
    if (!payload) {
      this.clearTokenIfCurrent(token);
      return null;
    }
    if (!payload.accountInstanceId) {
      return this.upgradeLegacyTokenIdentity(token, payload);
    }

    return withMockAccountLock(payload.sub, async () => {
      const user = await mockGet<MockUserRow>('users', payload.sub);
      const closure = await mockGet<{ key: string; value: unknown }>(
        'kv',
        mockAccountClosureKey(payload.sub, payload.accountInstanceId!),
      );
      if (closure) {
        this.closureRetryToken = token;
        this.clearTokenIfCurrent(token);
        return null;
      }
      if (!user || user.accountInstanceId !== payload.accountInstanceId) {
        this.clearTokenIfCurrent(token);
        return null;
      }
      if (!forceRefresh && payload.exp > Date.now()) {
        return localStorage.getItem(TOKEN_KEY) === token ? { token, user } : null;
      }
      const fresh = mintToken(user);
      return this.replaceTokenIfCurrent(token, fresh) ? { token: fresh, user } : null;
    });
  }

  private async upgradeLegacyTokenIdentity(
    token: string,
    payload: MockTokenPayload,
  ): Promise<LiveMockIdentity | null> {
    return withMockAccountLock(payload.sub, async () => {
      const current = await mockGet<MockUserRow>('users', payload.sub);
      if (
        !current ||
        current.accountInstanceId ||
        current.username !== payload.username ||
        current.accountType !== payload['custom:accountType']
      ) {
        this.clearTokenIfCurrent(token);
        return null;
      }
      const upgraded = { ...current, accountInstanceId: crypto.randomUUID() };
      await mockPut('users', upgraded);
      const upgradedToken = mintToken(upgraded);
      return this.replaceTokenIfCurrent(token, upgradedToken)
        ? { token: upgradedToken, user: upgraded }
        : null;
    });
  }

  private clearTokenIfCurrent(expected: string): void {
    if (localStorage.getItem(TOKEN_KEY) === expected) localStorage.removeItem(TOKEN_KEY);
  }

  private replaceTokenIfCurrent(expected: string, replacement: string): boolean {
    if (localStorage.getItem(TOKEN_KEY) !== expected) return false;
    localStorage.setItem(TOKEN_KEY, replacement);
    return true;
  }

  private async withCredentialMutation<T>(
    username: string,
    operation: (credential: MockCredentialRow, user: MockUserRow) => Promise<T>,
    expectedIdentity?: { userId: string; accountInstanceId: string },
  ): Promise<T> {
    const handle = username.trim().toLowerCase();
    const initialCredential = await mockGet<MockCredentialRow>('credentials', handle);
    if (!initialCredential) throw new AuthError('userNotFound');

    const identity = expectedIdentity ?? (await this.userOf(initialCredential.userId));
    const userId = expectedIdentity?.userId ?? identity.userId;
    const accountInstanceId = identity.accountInstanceId;
    if (!accountInstanceId || initialCredential.userId !== userId) {
      throw new AuthError('userNotFound');
    }

    return withMockAccountLock(userId, async () => {
      const credential = await mockGet<MockCredentialRow>('credentials', handle);
      const user = await mockGet<MockUserRow>('users', userId);
      if (
        !credential ||
        credential.userId !== userId ||
        !user ||
        user.accountInstanceId !== accountInstanceId
      ) {
        throw new AuthError('userNotFound');
      }
      const closure = await mockGet<{ key: string; value: unknown }>(
        'kv',
        mockAccountClosureKey(userId, accountInstanceId),
      );
      if (closure) throw new AuthError('userNotFound');
      return operation(credential, user);
    });
  }

  private async userOf(userId: string): Promise<MockUserRow> {
    const user = await mockGet<MockUserRow>('users', userId);
    if (!user) throw new AuthError('userNotFound');
    if (user.accountInstanceId) return user;
    return withMockAccountLock(userId, async () => {
      const current = await mockGet<MockUserRow>('users', userId);
      if (!current) throw new AuthError('userNotFound');
      if (current.accountInstanceId) return current;
      const upgraded = { ...current, accountInstanceId: crypto.randomUUID() };
      await mockPut('users', upgraded);
      return upgraded;
    });
  }

  private sessionOf(user: MockUserRow): AuthSession {
    return {
      user: {
        userId: user.userId,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        accountType: user.accountType,
      },
      issuedAt: Date.now(),
    };
  }

  private establish(user: MockUserRow): AuthNext {
    this.closureRetryToken = null;
    localStorage.setItem(TOKEN_KEY, mintToken(user));
    return { kind: 'done', session: this.sessionOf(user) };
  }
}
