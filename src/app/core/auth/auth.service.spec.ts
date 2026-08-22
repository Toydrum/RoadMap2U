import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_PROVIDER, type AuthProvider } from './auth-provider';
import type { AuthIdentitySnapshot, AuthNext, AuthSession } from './auth-types';
import {
  AUTH_IDENTITY_PERSISTENCE,
  AuthService,
  type AuthIdentityPersistence,
} from './auth.service';

const USER = {
  userId: 'owner-a',
  username: 'owner-a',
  email: 'owner@example.test',
  displayName: 'Owner',
  accountType: 'adult' as const,
};

const SESSION: AuthSession = { user: USER, issuedAt: 1_800_000_000_000 };
const SECOND_USER = {
  ...USER,
  userId: 'owner-b',
  username: 'owner-b',
  email: 'second@example.test',
};
const SECOND_SESSION: AuthSession = { user: SECOND_USER, issuedAt: 1_800_000_000_001 };

class FakeBroadcastChannel {
  static latest: FakeBroadcastChannel | null = null;
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== 'message') return;
    const callback =
      typeof listener === 'function'
        ? (listener as (event: MessageEvent) => void)
        : (event: MessageEvent) => listener.handleEvent(event);
    this.listeners.add(callback);
  }

  postMessage(): void {
    // Native BroadcastChannel does not echo to its posting instance.
  }

  emit(message: unknown = 'changed'): void {
    const event = { data: message } as MessageEvent;
    for (const listener of this.listeners) listener(event);
  }
}

function providerWith(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    signOut: vi.fn(async () => undefined),
    currentSession: vi.fn(async () => null),
    ...overrides,
  } as AuthProvider;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function serviceWith(provider: AuthProvider, persistence: AuthIdentityPersistence): AuthService {
  TestBed.configureTestingModule({
    providers: [
      AuthService,
      { provide: AUTH_PROVIDER, useValue: provider },
      { provide: AUTH_IDENTITY_PERSISTENCE, useValue: persistence },
    ],
  });
  return TestBed.inject(AuthService);
}

describe('AuthService account-closure races', () => {
  let persistence: {
    read: ReturnType<typeof vi.fn<AuthIdentityPersistence['read']>>;
    write: ReturnType<typeof vi.fn<AuthIdentityPersistence['write']>>;
    clear: ReturnType<typeof vi.fn<AuthIdentityPersistence['clear']>>;
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    FakeBroadcastChannel.latest = null;
    persistence = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ignores a validation session that resolves after sign-out began', async () => {
    let resolveSession!: (session: AuthSession | null) => void;
    let resolveProviderSignOut!: () => void;
    const currentSession = vi.fn(
      () => new Promise<AuthSession | null>((resolve) => (resolveSession = resolve)),
    );
    const providerSignOut = vi.fn(
      () => new Promise<void>((resolve) => (resolveProviderSignOut = resolve)),
    );
    const provider = providerWith({ currentSession, signOut: providerSignOut });
    persistence.read.mockResolvedValue({ key: 'auth.identity', user: USER, cachedAt: 1 });
    const service = serviceWith(provider, persistence);

    await service.hydrate();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(currentSession).toHaveBeenCalledOnce();

    const signingOut = service.signOut();
    expect(service.status()).toBe('guest');
    expect(providerSignOut).not.toHaveBeenCalled();
    resolveSession(SESSION);
    await flushPromises();
    expect(persistence.write).not.toHaveBeenCalled();
    expect(providerSignOut).toHaveBeenCalledOnce();

    resolveProviderSignOut();
    await signingOut;

    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
    expect(persistence.write).not.toHaveBeenCalled();
  });

  it('invalidates a stale hydrate when a sibling signs out before its read resolves', async () => {
    let resolveStaleRead!: (value: AuthIdentitySnapshot | undefined) => void;
    persistence.read
      .mockImplementationOnce(
        () =>
          new Promise<AuthIdentitySnapshot | undefined>(
            (resolve) => (resolveStaleRead = resolve),
          ),
      )
      .mockResolvedValueOnce(undefined);
    const service = serviceWith(providerWith(), persistence);

    const hydration = service.hydrate();
    FakeBroadcastChannel.latest?.emit();
    await flushPromises();
    resolveStaleRead({ key: 'auth.identity', user: USER, cachedAt: 1 });
    await hydration;
    await flushPromises();

    expect(persistence.read).toHaveBeenCalledTimes(2);
    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
  });

  it('discards a sign-in session that resolves after sign-out', async () => {
    let resolveNext!: (next: AuthNext) => void;
    const provider = providerWith({
      signIn: vi.fn(() => new Promise<AuthNext>((resolve) => (resolveNext = resolve))),
    });
    const service = serviceWith(provider, persistence);

    const signingIn = service.signIn('owner-a', 'secret');
    const signingOut = service.signOut();
    await flushPromises();
    resolveNext({ kind: 'done', session: SESSION });

    await expect(signingIn).resolves.toBe('error');
    await signingOut;
    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
    expect(persistence.write).not.toHaveBeenCalled();
  });

  it('serializes provider sessions so sign-out clears an older login and a newer login wins', async () => {
    let finishFirstSignIn!: () => void;
    let providerSession: string | null = null;
    const events: string[] = [];
    const provider = providerWith({
      signIn: vi.fn((username: string) => {
        events.push(`signIn:${username}`);
        if (username === 'owner-a') {
          return new Promise<AuthNext>((resolve) => {
            finishFirstSignIn = () => {
              providerSession = USER.userId;
              resolve({ kind: 'done', session: SESSION });
            };
          });
        }
        providerSession = SECOND_USER.userId;
        return Promise.resolve<AuthNext>({ kind: 'done', session: SECOND_SESSION });
      }),
      signOut: vi.fn(async () => {
        events.push('signOut');
        providerSession = null;
      }),
    });
    const service = serviceWith(provider, persistence);

    const first = service.signIn('owner-a', 'first-secret');
    const signingOut = service.signOut();
    const second = service.signIn('owner-b', 'second-secret');
    await flushPromises();
    finishFirstSignIn();

    await expect(first).resolves.toBe('error');
    await signingOut;
    await expect(second).resolves.toBe('done');
    await flushPromises();

    expect(events).toEqual(['signIn:owner-a', 'signOut', 'signIn:owner-b']);
    expect(providerSession).toBe(SECOND_USER.userId);
    expect(service.status()).toBe('signedIn');
    expect(service.user()).toEqual(SECOND_USER);
  });

  it('orders sign-out clear after an identity write that already started', async () => {
    let finishWrite!: () => void;
    let persisted: AuthIdentitySnapshot | undefined;
    const events: string[] = [];
    persistence.write.mockImplementation(
      (snapshot) =>
        new Promise<void>((resolve) => {
          events.push('write:start');
          finishWrite = () => {
            events.push('write:end');
            persisted = snapshot;
            resolve();
          };
        }),
    );
    persistence.clear.mockImplementation(async () => {
      events.push('clear');
      persisted = undefined;
    });
    const provider = providerWith({
      signIn: vi.fn(async (): Promise<AuthNext> => ({ kind: 'done', session: SESSION })),
    });
    const service = serviceWith(provider, persistence);

    await expect(service.signIn('owner-a', 'secret')).resolves.toBe('done');
    await flushPromises();
    expect(events).toEqual(['write:start']);

    const signingOut = service.signOut();
    await flushPromises();
    finishWrite();
    await signingOut;

    expect(events).toEqual(['write:start', 'write:end', 'clear']);
    expect(persisted).toBeUndefined();
    expect(service.status()).toBe('guest');
  });

  it('discards a direct sign-up session that resolves after sign-out', async () => {
    let resolveNext!: (next: AuthNext) => void;
    const provider = providerWith({
      signUp: vi.fn(() => new Promise<AuthNext>((resolve) => (resolveNext = resolve))),
    });
    const service = serviceWith(provider, persistence);

    const signingUp = service.signUp({
      username: 'owner-a',
      password: 'secret',
      email: 'owner@example.test',
      displayName: 'Owner',
    });
    const signingOut = service.signOut();
    await flushPromises();
    resolveNext({ kind: 'done', session: SESSION });

    await expect(signingUp).resolves.toBe('error');
    await signingOut;
    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
    expect(persistence.write).not.toHaveBeenCalled();
  });

  it('discards the confirm-sign-up session when its final sign-in resolves after sign-out', async () => {
    let resolveNext!: (next: AuthNext) => void;
    const provider = providerWith({
      signUp: vi.fn(async () => ({
        kind: 'confirmSignUp' as const,
        username: 'owner-a',
        deliveryHint: 'o***@e***',
      })),
      confirmSignUp: vi.fn(async () => undefined),
      signIn: vi.fn(() => new Promise<AuthNext>((resolve) => (resolveNext = resolve))),
    });
    const service = serviceWith(provider, persistence);
    await expect(
      service.signUp({
        username: 'owner-a',
        password: 'secret',
        email: 'owner@example.test',
        displayName: 'Owner',
      }),
    ).resolves.toBe('confirmSignUp');

    const confirming = service.confirmCode('123456');
    await flushPromises();
    expect(provider.signIn).toHaveBeenCalledOnce();
    const signingOut = service.signOut();
    resolveNext({ kind: 'done', session: SESSION });

    await expect(confirming).resolves.toBe('error');
    await signingOut;
    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
    expect(persistence.write).not.toHaveBeenCalled();
  });

  it('discards a new-password session that resolves after sign-out', async () => {
    let resolveNext!: (next: AuthNext) => void;
    const provider = providerWith({
      completeNewPassword: vi.fn(
        () => new Promise<AuthNext>((resolve) => (resolveNext = resolve)),
      ),
    });
    const service = serviceWith(provider, persistence);

    const completing = service.completeNewPassword('new-secret');
    const signingOut = service.signOut();
    await flushPromises();
    resolveNext({ kind: 'done', session: SESSION });

    await expect(completing).resolves.toBe('error');
    await signingOut;
    expect(service.status()).toBe('guest');
    expect(service.user()).toBeNull();
    expect(persistence.write).not.toHaveBeenCalled();
  });
});
