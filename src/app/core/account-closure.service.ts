import { DestroyRef, Injectable, InjectionToken, Injector, inject, signal } from '@angular/core';
import { API_CLIENT } from './api/api-client';
import {
  ApiError,
  type ApiErrorCode,
  type AccountClosureReceipt,
  type AccountClosureState,
} from './api/contracts';
import { AuthService } from './auth/auth.service';
import {
  ACCOUNT_CLOSURE_FENCE_KEY,
  activeAccountClosureReceiptKey,
  commitAccountClosureSnapshot,
  get,
} from './db/idb';
import { broadcastChange, onDbChange } from './db/broadcast';
import { quiesceAccountClosureWrites } from './db/account-closure-fence';
import { hash } from './hash';

const META_ACCOUNT_CLOSURE_PREFIX = 'account.closure:';
const ACCOUNT_CLOSURE_FORMAT_VERSION = 1 as const;
const SAFE_CLOSURE_ID = /^[A-Za-z0-9:._/-]{1,256}$/;
const CLOSURE_STATES: ReadonlySet<AccountClosureState> = new Set([
  'requested',
  'purging',
  'purgeComplete',
  'completed',
]);

export interface AccountClosureSnapshot {
  readonly key: string;
  readonly formatVersion: typeof ACCOUNT_CLOSURE_FORMAT_VERSION;
  readonly receipt: AccountClosureReceipt;
}

export interface AccountClosureStorage {
  read(key: string): Promise<unknown>;
  commit(key: string, value: AccountClosureSnapshot): Promise<AccountClosureSnapshot>;
  readActiveReceiptKey(): Promise<string | null>;
}

/** Auth scope without storing the Cognito sub itself in a key or value. */
export function accountClosureStorageKeyForOwner(ownerId: string): string {
  return `${META_ACCOUNT_CLOSURE_PREFIX}${hash(`closure-a:${ownerId}`).toString(36)}-${hash(`closure-b:${ownerId}`).toString(36)}-${ownerId.length}`;
}

export const ACCOUNT_CLOSURE_STORAGE = new InjectionToken<AccountClosureStorage>(
  'ACCOUNT_CLOSURE_STORAGE',
  {
    providedIn: 'root',
    factory: () => ({
      read: (key) => get<unknown>('meta', key),
      commit: (_key, value) => commitAccountClosureSnapshot(value),
      readActiveReceiptKey: () => activeAccountClosureReceiptKey(),
    }),
  },
);

export interface AccountClosureCoordination {
  subscribe(listener: () => void): () => void;
  publish(receiptKey: string, terminal: boolean): void;
}

export const ACCOUNT_CLOSURE_COORDINATION = new InjectionToken<AccountClosureCoordination>(
  'ACCOUNT_CLOSURE_COORDINATION',
  {
    providedIn: 'root',
    factory: () => ({
      subscribe: (listener) =>
        onDbChange((message) => {
          if (
            message.store === 'meta' &&
            message.ids.some(
              (id) =>
                id === ACCOUNT_CLOSURE_FENCE_KEY || id.startsWith(META_ACCOUNT_CLOSURE_PREFIX),
            )
          ) {
            listener();
          }
        }),
      publish: (receiptKey, terminal) => {
        if (terminal) quiesceAccountClosureWrites();
        broadcastChange({
          store: 'meta',
          ids: terminal ? [receiptKey, ACCOUNT_CLOSURE_FENCE_KEY] : [receiptKey],
        });
      },
    }),
  },
);

export interface AccountClosureActions {
  exportLocalCopy(): Promise<void>;
  clearLocalCopy(receiptKey: string): Promise<void>;
  finalizeLocalClosure(receiptKey: string): Promise<void>;
}

/**
 * The account route stays outside the product graph. These dynamic imports
 * are therefore intentional: simply rendering `/account` constructs neither
 * BackupService nor SyncService/repositories. The local-first graph wakes only
 * after the adult confirms closure (export) or a terminal receipt needs its
 * coordinated local cleanup.
 */
export const ACCOUNT_CLOSURE_ACTIONS = new InjectionToken<AccountClosureActions>(
  'ACCOUNT_CLOSURE_ACTIONS',
  {
    providedIn: 'root',
    factory: () => {
      const injector = inject(Injector);
      return {
        exportLocalCopy: async () => {
          const { BackupService } = await import('./repos/backup.service');
          await injector.get(BackupService).download('roadmap2u-pre-account-closure');
        },
        clearLocalCopy: async (receiptKey) => {
          const { LocalAccountDataService } = await import('./local-account-data.service');
          await injector.get(LocalAccountDataService).clear(receiptKey);
        },
        finalizeLocalClosure: async (receiptKey) => {
          const { LocalAccountDataService } = await import('./local-account-data.service');
          await injector.get(LocalAccountDataService).finalize(receiptKey);
        },
      };
    },
  },
);

export type AccountClosureResult = AccountClosureState | 'error';

function receiptFrom(value: unknown): AccountClosureReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    !Object.hasOwn(candidate, 'closureId') ||
    !Object.hasOwn(candidate, 'state')
  ) {
    return null;
  }
  const closureId = candidate['closureId'];
  const state = candidate['state'];
  return typeof closureId === 'string' &&
    SAFE_CLOSURE_ID.test(closureId) &&
    typeof state === 'string' &&
    CLOSURE_STATES.has(state as AccountClosureState)
    ? { closureId, state: state as AccountClosureState }
    : null;
}

function snapshotFrom(value: unknown, expectedKey: string): AccountClosureSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const receipt = receiptFrom(candidate['receipt']);
  return Object.keys(candidate).length === 3 &&
    candidate['key'] === expectedKey &&
    candidate['formatVersion'] === ACCOUNT_CLOSURE_FORMAT_VERSION &&
    receipt
    ? {
        key: expectedKey,
        formatVersion: ACCOUNT_CLOSURE_FORMAT_VERSION,
        receipt,
      }
    : null;
}

function errorCode(error: unknown): ApiErrorCode {
  return error instanceof ApiError ? error.code : 'unknown';
}

/**
 * Durable browser-side half of the account-closure saga.
 *
 * DELETE /me is both the request and status/re-enqueue operation: the backend
 * returns its durable receipt with HTTP 202 even when `state` is completed.
 * Cognito is deleted just before that terminal transition, so a JWT can expire
 * before this client observes `completed`. There is no unauthenticated status
 * endpoint in the normative contract. In that gap we fail conservatively:
 * retain the receipt, forest, conflicts and session snapshot; never infer
 * completion from UNAUTHENTICATED or from an otherwise successful HTTP 202.
 */
@Injectable({ providedIn: 'root' })
export class AccountClosureService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly storage = inject(ACCOUNT_CLOSURE_STORAGE);
  private readonly actions = inject(ACCOUNT_CLOSURE_ACTIONS);
  private readonly coordination = inject(ACCOUNT_CLOSURE_COORDINATION);

  private readonly receiptSignal = signal<AccountClosureReceipt | null>(null);
  private readonly busySignal = signal(false);
  private readonly lastErrorSignal = signal<ApiErrorCode | null>(null);
  private hydratedKey: string | null = null;
  private hydrateInFlight: { key: string; promise: Promise<void> } | null = null;
  private hydrateScope: string | null = null;
  private hydrateGeneration = 0;
  private operation: Promise<AccountClosureResult> | null = null;

  readonly receipt = this.receiptSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly lastError = this.lastErrorSignal.asReadonly();

  constructor() {
    const stop = this.coordination.subscribe(() => this.refreshAfterExternalCommit());
    inject(DestroyRef).onDestroy(stop);
  }

  hydrate(): Promise<void> {
    const userId = this.auth.user()?.userId;
    if (!userId) {
      const guestTarget = 'guest-active-fence';
      const generation = this.beginHydrateScope(guestTarget);
      if (this.hydrateInFlight?.key === guestTarget) return this.hydrateInFlight.promise;
      const promise = (async () => {
        try {
          const key = await this.storage.readActiveReceiptKey();
          if (generation !== this.hydrateGeneration || this.auth.user() || !key) {
            if (!this.auth.user()) {
              this.hydratedKey = null;
              this.receiptSignal.set(null);
            }
            return;
          }
          const snapshot = snapshotFrom(await this.storage.read(key), key);
          if (
            generation === this.hydrateGeneration &&
            !this.auth.user() &&
            snapshot?.receipt.state === 'completed'
          ) {
            this.hydratedKey = key;
            this.receiptSignal.set(snapshot.receipt);
          }
        } catch {
          // An active fence without a canonical terminal receipt stays
          // blocked; never infer that cleanup completed.
        }
      })().finally(() => {
        if (this.hydrateInFlight?.promise === promise) this.hydrateInFlight = null;
      });
      this.hydrateInFlight = { key: guestTarget, promise };
      return promise;
    }
    const key = accountClosureStorageKeyForOwner(userId);
    const generation = this.beginHydrateScope(key);
    if (this.hydratedKey === key) return Promise.resolve();
    if (this.hydrateInFlight?.key === key) return this.hydrateInFlight.promise;
    this.hydratedKey = key;
    this.receiptSignal.set(null);
    const promise = (async () => {
      try {
        const snapshot = snapshotFrom(await this.storage.read(key), key);
        if (
          this.auth.user()?.userId === userId &&
          generation === this.hydrateGeneration &&
          this.hydratedKey === key &&
          snapshot
        ) {
          this.receiptSignal.set(snapshot.receipt);
        }
      } catch {
        // Storage unavailable: a later explicit request may still run in
        // memory, but no destructive step is inferred from a missing row.
      }
    })().finally(() => {
      if (this.hydrateInFlight?.promise === promise) this.hydrateInFlight = null;
    });
    this.hydrateInFlight = { key, promise };
    return promise;
  }

  requestClosure(): Promise<AccountClosureResult> {
    return this.run(true);
  }

  retry(): Promise<AccountClosureResult> {
    return this.run(false);
  }

  private run(exportIfNew: boolean): Promise<AccountClosureResult> {
    if (this.operation) return this.operation;
    this.busySignal.set(true);
    this.lastErrorSignal.set(null);
    const operation = this.advance(exportIfNew)
      .catch((error: unknown) => {
        this.lastErrorSignal.set(errorCode(error));
        return 'error' as const;
      })
      .finally(() => {
        if (this.operation === operation) this.operation = null;
        this.busySignal.set(false);
      });
    this.operation = operation;
    return operation;
  }

  private async advance(exportIfNew: boolean): Promise<AccountClosureResult> {
    await this.hydrate();
    const current = this.receiptSignal();
    const hydratedKey = this.hydratedKey;
    if (current?.state === 'completed' && hydratedKey) {
      return this.finishTerminal(hydratedKey, false);
    }

    const ownerId = this.auth.user()?.userId;
    if (!ownerId) throw new ApiError('UNAUTHENTICATED');
    const key = accountClosureStorageKeyForOwner(ownerId);
    this.assertOwner(ownerId, key);

    // A receipt proves the initial request happened only after a successful
    // download. A lost response has no receipt, so retry safely exports again
    // before invoking the idempotent endpoint.
    if (!current && !exportIfNew) throw new Error('no pending closure for this account');
    if (!current) await this.actions.exportLocalCopy();
    this.assertOwner(ownerId, key);

    const receipt = receiptFrom(await this.api.deleteMe());
    this.assertOwner(ownerId, key);
    if (!receipt) throw new Error('invalid account closure receipt');
    // Keep the server response in memory if IndexedDB is temporarily
    // unavailable. It is not destructive authority: terminal cleanup still
    // requires the durable commit/fence below.
    this.receiptSignal.set(receipt);
    const committed = snapshotFrom(
      await this.storage.commit(key, {
        key,
        formatVersion: ACCOUNT_CLOSURE_FORMAT_VERSION,
        receipt,
      }),
      key,
    );
    if (!committed) throw new Error('invalid committed account closure receipt');
    if (committed.receipt.closureId !== receipt.closureId) {
      throw new Error('account closure receipt changed identity');
    }
    if (stateRank(committed.receipt.state) < stateRank(receipt.state)) {
      throw new Error('account closure state regressed');
    }
    this.receiptSignal.set(committed.receipt);
    this.coordination.publish(key, committed.receipt.state === 'completed');
    return committed.receipt.state === 'completed'
      ? this.finishTerminal(key, true)
      : committed.receipt.state;
  }

  private async finishTerminal(
    key: string,
    terminalCommitAlreadyConfirmed: boolean,
  ): Promise<'completed'> {
    if (!terminalCommitAlreadyConfirmed) {
      const current = this.receiptSignal();
      if (current?.state !== 'completed') {
        throw new Error('terminal account closure receipt is missing');
      }
      const committed = snapshotFrom(
        await this.storage.commit(key, {
          key,
          formatVersion: ACCOUNT_CLOSURE_FORMAT_VERSION,
          receipt: current,
        }),
        key,
      );
      if (!committed || committed.receipt.state !== 'completed') {
        throw new Error('terminal account closure fence was not activated');
      }
      this.receiptSignal.set(committed.receipt);
      this.coordination.publish(key, true);
    }
    // The receipt and durable generation fence remain persisted through
    // cleanup. If a tab/storage failure interrupts either step, reload can
    // resume locally without needing a JWT.
    await this.actions.clearLocalCopy(key);
    await this.auth.signOut();
    await this.actions.finalizeLocalClosure(key);
    this.hydrateGeneration += 1;
    this.hydrateScope = null;
    this.hydrateInFlight = null;
    this.receiptSignal.set(null);
    this.hydratedKey = null;
    return 'completed';
  }

  private refreshAfterExternalCommit(): void {
    // Invalidate a same-owner cached hydrate as well as any slower read which
    // is still in flight. The durable CAS remains authority; this is only the
    // cross-tab signal refresh.
    this.hydrateGeneration += 1;
    this.hydrateScope = null;
    this.hydrateInFlight = null;
    this.hydratedKey = null;
    void this.hydrate();
  }

  private assertOwner(ownerId: string, key: string): void {
    if (
      this.auth.user()?.userId !== ownerId ||
      this.hydratedKey !== key ||
      key !== accountClosureStorageKeyForOwner(ownerId)
    ) {
      throw new ApiError('UNAUTHENTICATED', 'account closure auth scope changed');
    }
  }

  private beginHydrateScope(scope: string): number {
    if (scope !== this.hydrateScope) {
      this.hydrateScope = scope;
      this.hydrateGeneration += 1;
      this.hydrateInFlight = null;
    }
    return this.hydrateGeneration;
  }
}

function stateRank(state: AccountClosureState): number {
  switch (state) {
    case 'requested':
      return 0;
    case 'purging':
      return 1;
    case 'purgeComplete':
      return 2;
    case 'completed':
      return 3;
  }
}
