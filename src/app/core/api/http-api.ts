import { ApiClient } from './api-client';
import {
  API_PATHS,
  AccessSummary,
  AccountClosureReceipt,
  ApiError,
  ApiErrorCode,
  CodeGrant,
  CreateChildRequest,
  CreateChildResponse,
  FamilyInviteRequest,
  FamilyLinkView,
  FriendRequestView,
  FriendView,
  FriendsResponse,
  ForestSnapshot,
  MeResponse,
  PlanCatalog,
  SERVER_API_ERROR_CODES,
  SyncChangesResponse,
  SyncPushPayload,
  SyncPushResponse,
  UserProfile,
} from './contracts';
import { ExportEnvelope } from '../db/schema';
import { AuthProvider } from '../auth/auth-provider';
import { APP_CONFIG } from '../config';

/**
 * The real transport — dormant while APP_CONFIG.backend is 'mock'. Plain
 * fetch (the app has no HttpClient idiom and needs none): bearer idToken,
 * one forceRefresh retry on 401, fixed 250 ms → 1 s backoff on 5xx/network
 * (deliberately not jittered — two retries at this scale need no spread, and
 * the repo bans Math.random), fast ApiError('offline') when the browser
 * already knows it is offline.
 */

const SERVER_CODES: ReadonlySet<string> = new Set(SERVER_API_ERROR_CODES);

const BACKOFF_MS = [250, 1000] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpApi implements ApiClient {
  private readonly base = `${APP_CONFIG.aws.apiBaseUrl}/v1`;

  constructor(private readonly auth: AuthProvider) {}

  // ── commercial access ────────────────────────────────────────────────────
  getPlans(): Promise<PlanCatalog> {
    return this.request('GET', API_PATHS.plans, undefined, { authenticated: false });
  }
  getAccess(): Promise<AccessSummary> {
    return this.request('GET', API_PATHS.access);
  }
  redeemAccessCode(code: string): Promise<AccessSummary> {
    return this.request('POST', API_PATHS.accessCodesRedeem, { code }, { idempotent: true });
  }

  // ── me ────────────────────────────────────────────────────────────────────
  getMe(): Promise<MeResponse> {
    return this.request('GET', API_PATHS.me);
  }
  patchMe(patch: { displayName?: string }): Promise<UserProfile> {
    return this.request('PATCH', API_PATHS.me, patch);
  }
  deleteMe(): Promise<AccountClosureReceipt> {
    return this.request('DELETE', API_PATHS.me, undefined, { idempotent: true });
  }

  // ── family ────────────────────────────────────────────────────────────────
  createChild(req: CreateChildRequest): Promise<CreateChildResponse> {
    return this.request('POST', API_PATHS.familyChildren, req);
  }
  resetChildPassword(userId: string): Promise<{ tempPassword: string }> {
    return this.request('POST', API_PATHS.familyChildResetPassword(userId));
  }
  patchChild(
    userId: string,
    patch: { displayName?: string; socialEnabled?: boolean },
  ): Promise<UserProfile> {
    return this.request('PATCH', API_PATHS.familyChild(userId), patch);
  }
  exportChild(userId: string): Promise<ExportEnvelope> {
    return this.request('GET', API_PATHS.familyChildExport(userId));
  }
  deleteChild(userId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.familyChild(userId));
  }
  deleteFamilyLink(linkId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.familyLink(linkId));
  }
  createFamilyInvite(req: FamilyInviteRequest): Promise<CodeGrant> {
    return this.request('POST', API_PATHS.familyInvites, req);
  }
  acceptFamilyInvite(code: string): Promise<FamilyLinkView> {
    return this.request('POST', API_PATHS.familyInvitesAccept, { code });
  }
  revokeFamilyInvite(code: string): Promise<void> {
    return this.request('DELETE', API_PATHS.familyInvite(code));
  }
  listChildFriends(userId: string): Promise<FriendsResponse> {
    return this.request('GET', API_PATHS.familyChildFriends(userId));
  }
  removeChildFriendship(userId: string, friendshipId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.familyChildFriend(userId, friendshipId));
  }
  cancelChildRequest(userId: string, requestId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.familyChildRequest(userId, requestId));
  }

  // ── friends ───────────────────────────────────────────────────────────────
  getFriends(): Promise<FriendsResponse> {
    return this.request('GET', API_PATHS.friends);
  }
  getFriendCode(): Promise<CodeGrant> {
    return this.request('GET', API_PATHS.friendCode);
  }
  rotateFriendCode(): Promise<CodeGrant> {
    return this.request('POST', API_PATHS.friendCodeRotate);
  }
  createFriendRequest(code: string): Promise<FriendRequestView> {
    return this.request('POST', API_PATHS.friendRequests, { code });
  }
  acceptFriendRequest(requestId: string): Promise<FriendView> {
    return this.request('POST', API_PATHS.friendRequestAccept(requestId));
  }
  declineFriendRequest(requestId: string): Promise<void> {
    return this.request('POST', API_PATHS.friendRequestDecline(requestId));
  }
  cancelFriendRequest(requestId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.friendRequest(requestId));
  }
  removeFriend(friendshipId: string): Promise<void> {
    return this.request('DELETE', API_PATHS.friend(friendshipId));
  }

  // ── forests & sync ────────────────────────────────────────────────────────
  getForest(userId: string): Promise<ForestSnapshot> {
    return this.request('GET', API_PATHS.userForest(userId));
  }
  getSyncChanges(cursor?: string): Promise<SyncChangesResponse> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request('GET', `${API_PATHS.syncChanges}${query}`);
  }
  pushSync(req: SyncPushPayload): Promise<SyncPushResponse> {
    return this.request('POST', API_PATHS.syncPush, req, { idempotent: true });
  }
  pushSyncFor(userId: string, req: SyncPushPayload): Promise<SyncPushResponse> {
    return this.request('POST', API_PATHS.userSyncPush(userId), req, { idempotent: true });
  }

  // ── transport ─────────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { authenticated?: boolean; idempotent?: boolean } = {},
  ): Promise<T> {
    // 5xx retries are safe only when re-sending can't double an effect:
    // GETs always, sync pushes by contract (rev-LWW makes them replayable).
    // A createChild/accept retried after a committed-then-500 would run twice.
    const retryOn5xx = method === 'GET' || options.idempotent === true;
    const authenticated = options.authenticated !== false;
    let forceRefresh = false;
    let retries = 0;
    for (;;) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) throw new ApiError('offline');
      const token = authenticated
        ? await this.auth.idToken(forceRefresh ? { forceRefresh: true } : undefined)
        : null;

      let response: Response;
      try {
        response = await fetch(this.base + path, {
          method,
          headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch {
        // fetch TypeError is the truth about the network, onLine only a hint.
        // But a dropped connection can arrive AFTER the server committed the
        // write (committed-then-drop) — so only idempotent requests retry
        // (0.0.115 M3): a replayed createChild would answer USERNAME_TAKEN
        // without ever showing the temp password of a child that DOES exist.
        if (retryOn5xx && retries < BACKOFF_MS.length) {
          await wait(BACKOFF_MS[retries]);
          retries += 1;
          continue;
        }
        throw new ApiError('offline');
      }

      if (authenticated && response.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      if (response.status >= 500 && retryOn5xx && retries < BACKOFF_MS.length) {
        await wait(BACKOFF_MS[retries]);
        retries += 1;
        continue;
      }
      if (!response.ok) throw await this.errorFrom(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  private async errorFrom(response: Response): Promise<ApiError> {
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      const code = body?.error?.code;
      if (code && SERVER_CODES.has(code)) {
        return new ApiError(code as ApiErrorCode, body.error?.message);
      }
    } catch {
      /* non-JSON error body */
    }
    if (response.status === 401) return new ApiError('UNAUTHENTICATED');
    if (response.status === 403) return new ApiError('FORBIDDEN');
    if (response.status === 404) return new ApiError('NOT_FOUND');
    return new ApiError('server', `HTTP ${response.status}`);
  }
}
