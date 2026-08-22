# RoadMap2U — Backend Contract (Cognito + API Gateway + Lambda + DynamoDB)

**Normative types: [`src/app/core/api/contracts.ts`](../src/app/core/api/contracts.ts).** This document explains the semantics; the TypeScript file is the single source of shapes, paths, error codes and limits. Three implementations type against it: the on-device mock (`core/api/mock-api.ts` — the _executable spec_), the client transport (`core/api/http-api.ts`), and the Lambda router in [`Toydrum/roadmap2u-backend`](https://github.com/Toydrum/roadmap2u-backend), which consumes a parity-checked vendored copy. If a shape needs to change, change `contracts.ts` first and let the compiler surface every consequence.

Owner decisions baked in (2026-07-06): login becomes **mandatory at AWS go-live**; guardians can **edit/plant** in a linked minor's forest (co-gardening); **linking existing accounts** ships in v1; infrastructure-as-code lives in the separate backend repository.

---

## 1. Principles

1. **Local-first storage.** The device's IndexedDB is the working copy. The cloud is a per-user record store + identity + relationships. Sync is per-record LWW by `rev` — the exact law `RecordsRepo.applyExternal` already applies locally.
2. **The profile table is the authorization truth.** Lambdas authorize per request from DynamoDB link records — never from token claims alone. The `custom:accountType` claim is defense-in-depth.
3. **No discovery.** No user search, no public profiles, no username-availability endpoint (only `USERNAME_TAKEN` on create). Codes are the only introduction. Denied forest reads return `NOT_FOUND`, never `FORBIDDEN` — no existence oracle.
4. **Privacy boundaries are server-side.** Stripping (`note`/`trigger`/`targetDate`) happens in the Lambda, not the client. Check-ins, sessions and settings are NEVER served to another user, ever.
5. **No-shame mechanics.** Friend declines are silent; requests expire quietly (14 days); nothing notifies rejection.
6. **The mock is the spec.** Every rule here is enforced by `mock-api.ts` against the on-device `roadmap2u-mockcloud` DB with deterministic fixtures (`mock-seed.ts`). If mock and doc disagree, fix one — before go-live they must agree.

## 2. Identity — Cognito user pool

Checklist (mirrored in `cognito-auth.provider.ts`; the backend stack implements it):

- Sign-in by **username** (3–20 `[a-z0-9_]`, unique). Email is an **optional, verifiable attribute** — adults have one, guardian-created minors have none (the guardian IS the recovery channel).
- App client **without secret**; `ALLOW_USER_SRP_AUTH` (+ refresh). No Hosted UI and no OAuth flows; the app uses its custom account UI and needs no redirect callback.
- Verification & recovery by **CODE**, never emailed links.
- Password policy = `PASSWORD_POLICY` in `auth-types.ts` (min 8, upper+lower+digit). Align the pool to the const.
- Custom attribute `custom:accountType: 'adult' | 'minor'`, mutable, **written by the backend only** (PostConfirmation trigger for self-signups → `adult`; `AdminCreateUser` for minors → `minor`).
- Self-signup **enabled** (creates adults; PostConfirmation Lambda writes the DynamoDB profile). Minors are born ONLY via `POST /family/children` → `AdminCreateUser` (`MessageAction: SUPPRESS`, temp password) → the child's first sign-in lands in `NEW_PASSWORD_REQUIRED`.
- Guardian password reset for `created` minors = `AdminSetUserPassword` (temporary), returned once as `tempPassword`.

## 3. Accounts, family, friends

```
AccountType 'adult' | 'minor'      ('teen' is NOT a type)
UserProfile { userId, username, displayName, accountType, socialEnabled, createdAt }
GuardianLink { linkId, guardianId, minorId, kind: 'created'|'invited', createdAt }
Friendship { friendshipId, userA, userB, createdAt }
```

- **Parent/admin** = adult with ≥1 GuardianLink as guardian. **Child** = minor + `socialEnabled: false` (no friend surfaces at all). **Teen** = minor + `socialEnabled: true` (friends + visits; still guardian-administered). Adults always `socialEnabled: true`.
- **Link kinds.** `created` (guardian created this minor): full identity admin — rename, reset password, social toggle, export-first delete. `invited` (an existing account accepted a family invite): guardian gets forest view+**edit** and friend oversight, but NO identity admin (the account owns itself; either side can unlink).
- Caps (`LIMITS`): ≤2 guardians per minor · ≤8 children per guardian · ≤50 friends · sync push ≤100 records · mutation group ≤20 records · 5 bad code redemptions/hour.
- **LAST_GUARDIAN rule:** the last active link on a `created` minor cannot be removed (an orphaned minor could never recover a password). The exit is export-first deletion.
- **Invites** (`POST /family/invites`): `{kind:'coGuardian', minorId}` → another ADULT redeems and co-guards that minor; only a guardian whose `created` link is still active may issue or complete this delegation, so an `invited` guardian cannot escalate another adult. `{kind:'linkExisting'}` → any existing account redeems and becomes the issuer's `invited` minor-side link. Codes: 8 chars, 72 h, single-use. Consent = redemption.
- **Friend codes** (`GET /friends/code`): 8 chars (Crockford base32, no vowels/lookalikes), 7-day expiry, multi-use until expiry/rotation; every redemption still requires an explicit accept. `POST /friends/code/rotate` invalidates immediately. Requests expire after 14 days; declines are silent.
- **Guardian oversight:** guardians list/remove a minor's friendships and cancel their outgoing requests — but cannot INITIATE requests for the minor. The minor sees exactly what the guardian sees (no covert controls). Toggling `socialEnabled` off hides friend surfaces and blocks visits both ways but **destroys nothing**.

## 4. Permissions matrix (Lambda authz AND client gating)

| Actor → target                        | View forest          | Node notes/dates         | Feelings/check-ins/sessions | Edit/plant             | Administer identity            |
| ------------------------------------- | -------------------- | ------------------------ | --------------------------- | ---------------------- | ------------------------------ |
| self → own                            | yes                  | yes                      | yes                         | yes                    | own                            |
| guardian → linked minor (both kinds)  | yes — **full** nodes | yes (they can edit them) | **never**                   | **yes** (co-gardening) | `created`: yes · `invited`: no |
| minor → their guardian                | yes — stripped       | no                       | never                       | no                     | no                             |
| friend ↔ friend (both social-enabled) | yes — stripped       | no                       | never                       | no                     | no                             |
| child (social off) → non-family       | nothing              | —                        | —                           | —                      | —                              |
| stranger → anyone                     | **404**              | —                        | —                           | —                      | —                              |

_Stripped_ = `note → ''`, `trigger → null`, `targetDate → null`, archived + tombstoned excluded. Visits render a neutral sky (weather derives from private feelings). Family visibility is **mutual** and disclosed to the child in-UI.

## 5. API surface

REST under `${apiBaseUrl}/v1`, JSON, `Authorization: Bearer <Cognito idToken>` (HTTP API JWT authorizer). Paths/verbs in `API_PATHS` + `http-api.ts`. Sign-in/up/challenges are NOT here — they ride the Cognito SDK through the `AuthProvider` seam.

`GET /plans` is the one public exception: it does not request or send an ID token. The compiled prepayment catalog is version `2026-08-prepayment-v1` / pricing `launch-2026`, uses `MXN`, includes tax, and fixes `paymentsEnabled: false`. Free has 2 active trees and 10 visible branches per tree with no cloud/social/family capability. Premium has no commercial tree/branch limit in this catalog, enables cloud sync and social (family remains false), and publishes $99 MXN/month (`9900` minor units) or $949 MXN/year (`94900`). `null` means no commercial limit, never no technical cap. No payment SDK, checkout, Price ID, subscription source, or client-selected amount exists in this phase.

`GET /access` returns the authoritative `AccessSummary`: effective plan, independent active sources, materialized limits/capabilities/usage, monotonic revision, next recompute boundary, and offline lease. Source kind `subscription` is reserved for the later payments phase and is not minted now. Missing access fails closed to an active Free summary; `offlineValidUntil = min(now + 24 h, nextRecomputeAt)` when a recompute boundary exists. Numeric limits combine by maximum with `null` dominant; boolean capabilities combine by union.

| Group      | Endpoints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commercial | `GET /plans` (**public, no token**) · `GET /access` (JWT) · `POST /access-codes/redeem {code}` (JWT, returns refreshed `AccessSummary`)                                                                                                                                                                                                                                                                                                                                                                                                            |
| me         | `GET /me` (profile + family links — one call paints the account section) · `PATCH /me` (displayName) · `DELETE /me` (durable account closure receipt `{closureId,state}`; `state ∈ requested\|purging\|purgeComplete\|completed`)                                                                                                                                                                                                                                                                                                                  |
| family     | `POST /family/children` → `{child, tempPassword}` (shown once) · `POST /family/children/:id/reset-password` · `PATCH /family/children/:id` (displayName, socialEnabled) · `GET /family/children/:id/export` (ExportEnvelope) · `DELETE /family/children/:id` (export-first client flow) · `DELETE /family/links/:linkId` · `POST /family/invites` · `POST /family/invites/accept` · `DELETE /family/invites/:code` · `GET /family/children/:id/friends` · `DELETE /family/children/:id/friends/:fid` · `DELETE /family/children/:id/requests/:rid` |
| friends    | `GET /friends` (friends + incoming + outgoing) · `GET /friends/code` · `POST /friends/code/rotate` · `POST /friends/requests {code}` · `POST /friends/requests/:id/accept` · `POST /friends/requests/:id/decline` · `DELETE /friends/requests/:id` · `DELETE /friends/:friendshipId`                                                                                                                                                                                                                                                               |
| forests    | `GET /users/:id/forest` → `ForestSnapshot { owner, detail: 'full'\|'stripped', trees, nodes, fetchedAt }` — detail chosen by relationship per §4                                                                                                                                                                                                                                                                                                                                                                                                   |
| sync       | `GET /sync/changes?cursor=` · `POST /sync/push` · `POST /users/:id/sync/push` (guardian write-through: records land in the minor's store; their devices pull them)                                                                                                                                                                                                                                                                                                                                                                                 |

**Errors:** envelope `{ error: { code, message } }`; `code ∈ ApiErrorCode` (SCREAMING codes on the wire; lowercase `offline|server|unknown` are client-minted). `message` is for developers — the client maps codes to i18n copy. Commercial/sync additions are `QUOTA_EXCEEDED`, `CAPABILITY_REQUIRED`, `MUTATION_GROUP_INVALID`, `ACCESS_REVISION_CONFLICT`, `ACCESS_CODE_INVALID`, `ACCESS_CODE_RATE_LIMITED`, `ACCESS_CODE_ALREADY_REDEEMED`, `SYNC_SCHEMA_INVALID`, `SYNC_CLIENT_UPGRADE_REQUIRED`, `USAGE_MIGRATION_IN_PROGRESS`, and `COMMERCIAL_CONFIGURATION_UNAVAILABLE`. Retryability is client policy, not a wire field: access-revision conflicts receive a bounded refresh/retry and an active usage-migration fence remains dirty for retry; quota rejection is never force-won.

**Sync semantics:**

- `CONTRACT_VERSION = 2` is independent from the forest `schemaVersion`. A v2 push carries `mutationGroups: Array<{id, expectedCount, records}>`; `expectedCount` is a safe integer, must equal `records.length`, and is 1–20. Group ids are unique within the request and total records across groups remain ≤100. An incomplete/oversized group is `MUTATION_GROUP_INVALID`; a malformed record is `SYNC_SCHEMA_INVALID`. The complete v2 request is prevalidated before writing, and each valid group is committed all-or-nothing. If any member loses LWW, no member of that group mutates; the response returns every stored stale winner so a future group-aware client can keep the full action pending. Earlier accepted groups are not rolled back when a later group conflicts. The legacy `SyncPushRequest {schemaVersion,records}` remains a first-class typed payload for already-deployed v12 clients, with records treated independently.
- Push: per record, accept iff `lwwBeats(incoming, stored)` — the ONE ordering in `contracts.ts`: higher `rev` wins, equal revs fall to `updatedAt`, exact ties keep the STORED copy (DynamoDB conditional write); else reject `{id, reason:'STALE_REV'}` AND return the stored winner in `serverRecords`. Clients accept server records on exact ties (`applyExternal`), so every replica converges on one copy.
- Tombstones (`deletedAt` set) travel as ordinary records; the server never physically deletes records (account deletion purges the whole partition).
- Change feed ordered by **server receive time** (`syncedAt`), exposed as an opaque `cursor`; page ≤ 200, `more` flag. Client clocks are never trusted for ordering.
- The server validates only `SyncBase` shape + the store enum and stores records opaquely → additive schema evolution (the `trigger`/`flow` precedent) needs zero backend change. A push with `schemaVersion` NEWER than the server understands → `SYNC_TOO_OLD` (client asks user to update the app... the server, actually — the error names the direction for the client copy).
- Settings are device preferences (no `rev`) — **not synced**.

## 6. DynamoDB — single table `roadmap`

On-demand billing, TTL enabled, 2 GSIs, item-per-record (a tree-document would fight the 400 KB item limit and break per-record LWW).

| Entity         | PK                      | SK                      | GSI1 PK / SK                            | GSI2 PK / SK                           | Notes                                                                            |
| -------------- | ----------------------- | ----------------------- | --------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Profile        | `USER#<id>`             | `PROFILE`               | —                                       | —                                      | username, displayName, accountType, socialEnabled, friendCode ptr                |
| Username guard | `UNIQ#USERNAME#<lower>` | `UNIQ`                  | —                                       | —                                      | TransactWrite + `attribute_not_exists`                                           |
| GuardianLink   | `USER#<minorId>`        | `GUARDIAN#<guardianId>` | `USER#<guardianId>` / `MINOR#<minorId>` | —                                      | one item, queryable both directions                                              |
| Friendship ×2  | `USER#<a>`              | `FRIEND#<b>`            | —                                       | —                                      | two mirrored items in one transaction (shared friendshipId)                      |
| FriendRequest  | `USER#<toId>`           | `FREQ#<reqId>`          | `USER#<fromId>` / `FREQ#<reqId>`        | —                                      | incoming = base query, outgoing = GSI1; TTL 14 d                                 |
| FriendCode     | `CODE#F#<code>`         | `CODE`                  | —                                       | —                                      | userId; TTL 7 d                                                                  |
| GuardianInvite | `CODE#G#<code>`         | `CODE`                  | —                                       | —                                      | issuerId, kind, minorId?; TTL 72 h                                               |
| Record         | `USER#<owner>`          | `REC#<store>#<id>`      | —                                       | `USER#<owner>` / `CHG#<syncedAt>#<id>` | full client record + server `syncedAt`; store ∈ trees\|nodes\|checkins\|sessions |

Access patterns: me = GetItem + two link queries · my minors = GSI1 · forest visit = two Queries (`begins_with REC#trees#` / `REC#nodes#`) + Lambda filter/strip · change feed = GSI2 Query after cursor · push = conditional PutItem per record (`attribute_not_exists(pk) OR rev < :rev OR (rev = :rev AND updatedAt < :updatedAt)` — `lwwBeats` as a condition; the Record item mirrors `updatedAt` top-level for it) · username uniqueness & friendship mirroring = TransactWriteItems. Null SyncBase fields stored as absent attributes.

## 7. Lambda authz rules (per group)

- **Every route:** JWT authorizer already verified the token; resolve `callerId = claims.sub`; load caller profile (404-shaped `UNAUTHENTICATED` if missing — deleted account with live token).
- **/family/children/:id/***: require an ACTIVE GuardianLink (caller = guardian, :id = minor). Identity-admin routes (`reset-password`, `PATCH socialEnabled`, `DELETE child`) additionally require `kind === 'created'`. `DELETE /family/links/:linkId`: caller must be that link's guardian; refuse `LAST_GUARDIAN` when it is a `created` minor's last link.
- **/friends/***: require caller `socialEnabled` (adults always). Redemption rate-limited (5 BAD attempts/hour → `RATE_LIMITED`; read-first, bump only on invalid/expired codes — successes never count). A second pending request to the same person is `CONFLICT`, race-proof via a per-direction deterministic requestId + conditional put. `maxFriends` is enforced at request time AND at accept (either side may have filled up while the request sat). Accept requires being the request's `toId`; cancel its `fromId`.
- **GET /users/:id/forest**: relationship lookup → `full` (guardian→minor), `stripped` (minor→guardian, friend↔friend), else `NOT_FOUND`. Friend visits additionally require `socialEnabled` on BOTH sides.
- **POST /users/:id/sync/push**: require GuardianLink guardian→:id (either kind). Same LWW law as own-push; records land in the minor's partition.

## 8. Mock parity

`mock-api.ts` + `mock-auth.provider.ts` enforce everything above on-device: same codes, same caps, same LWW, same strip rules. V2 group reads, change-sequence allocation and record writes share one IndexedDB transaction, so the executable spec cannot leave a half-written action. `getPlans()` is compiled and opens neither auth nor `roadmap2u-mockcloud`; authenticated `getAccess()` returns the deterministic Free fallback. The mock intentionally rejects arbitrary sponsored keys with generic `ACCESS_CODE_INVALID`: an on-device simulation has no owner broker or HMAC secret and must not invent a Premium backdoor. `deleteMe()` keeps feature code behind the API seam and returns a completed mock closure receipt after deleting the mock identity. Deterministic by doctrine (rule 4): confirmation code `123456`, fixed demo passwords, `hash()`-derived latencies (250–400 ms). Demo family (`mock-seed.ts`): **rocio** (adult guardian, `Bosque123`) · **nico** (created-minor, social off, temp `Semilla1!` → NEW_PASSWORD_REQUIRED) · **val** (minor, social on, friends with Ámbar) · **ambar** (adult, the lush visitable forest, `Bosque123`). "Restablecer la nube de prueba" (Settings, mock mode only) wipes `roadmap2u-mockcloud`; it reseeds on next use. Determinism is a MOCK property — the real backend uses crypto RNG for codes/passwords.

## 9. Rollout

| Phase                | Ships                                                                                                                                                                                                                                                     | Backend needed |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| «cuentas» (this one) | auth seams + /account ritual + contracts + this doc                                                                                                                                                                                                       | none (mock)    |
| «familia»            | /me UI, create-child, admin ops, both invite kinds                                                                                                                                                                                                        | none (mock)    |
| «conectar mi bosque» | sync engine (watermark push over `onLocalWrite`, cursor pull into `applyExternal`), connect action                                                                                                                                                        | none (mock)    |
| «amigos y visitas»   | friends UI, visit routes (route-scoped read-only repos), guardian co-gardening                                                                                                                                                                            | none (mock)    |
| **AWS go-live**      | Deploy `Toydrum/roadmap2u-backend` → verify its SSM handoff → enable the frontend AWS gate → deploy `main` to `dev` and promote the exact successful SHA through `test` to `prod` → **flip `requireAuth: true`** only when local-forest adoption is ready | all of it      |

The separate backend repository **implements this contract** with Cognito per §2, the table in §6, an HTTP API + JWT authorizer, and the router/handlers for §5/§7. Its vendored contract is guarded by byte parity and by the normalized deployment digest described in [`backend-extraction.md`](./backend-extraction.md). Each deployed stage publishes frontend configuration to SSM; the frontend generates `APP_CONFIG` during CI/CD and never accepts hand-copied stack outputs.

**The execution runbook lives in [`aws-connect.md`](./aws-connect.md)** — exact stage URLs, SSM handoff, GitHub variables, CORS boundaries, verification gates, promotion, cutover, and rollback. This document is the WHAT; that one is the HOW.
