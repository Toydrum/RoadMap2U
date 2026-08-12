# Architecture

## Architectural Style

- Primary style: local-first Angular PWA with explicit mock/AWS seams.
- Why this classification: IndexedDB repositories are the working copy; `APP_CONFIG` chooses mock or AWS implementations behind `AUTH_PROVIDER` and `API_CLIENT`; sync is opt-in.
- Primary constraints: no-shame product rules, deterministic visuals, bilingual copy, offline-first privacy, AWS auth/API code must stay lazy and out of initial bundle.

## System Flow

```text
src/main.ts -> appConfig providers -> Boot/Auth/Sync init -> lazy route component -> repo/API seam -> IndexedDB or backend API
```

1. `src/main.ts` bootstraps `App` with `appConfig`.
2. `app.config.ts` wires boot, auth hydration, sync init, router, service worker and lazy mock/AWS seams.
3. `app.routes.ts` lazy-loads features and applies `authRequiredGate` to all routes except `/account`.
4. Local data flows through `core/repos` and `core/db/idb.ts`.
5. Cloud behavior flows only through `core/api` and `core/auth`; AWS builds use generated config.
6. Visits can shadow repos with route-scoped `VisitTreesRepo`/`VisitNodesRepo` under `/visit/:userId`.

## Layer/Module Responsibilities

| Layer or module | Owns | Must not own | Evidence |
|-----------------|------|--------------|----------|
| `src/app/core/config.ts` | Runtime config seam | Manual copied stack outputs | `src/app/core/config.ts`, `docs/aws-connect.md` |
| `src/app/core/db` | IndexedDB persistence and cross-tab broadcast | Direct AWS calls | `src/app/core/db/idb.ts`, `src/app/core/db/broadcast.ts` |
| `src/app/core/api` | Contract, mock cloud, HTTP API adapter | Feature UI state | `src/app/core/api/contracts.ts`, `src/app/core/api/http-api.ts` |
| `src/app/core/auth` | Auth providers/facade/guard | Product feature pages | `src/app/core/auth/*.ts` |
| `src/app/features` | Route-level UX | Low-level storage adapters | `src/app/app.routes.ts`, `AGENTS.md` |
| `tools` | Verification/deploy support | Runtime imports | `tools/*.mjs` |

## Reused Patterns

| Pattern | Where found | Why it exists |
|---------|-------------|---------------|
| Lazy seam adapter | `src/app/core/lazy-seam.ts`, `app.config.ts` | Keep mock/AWS implementations off first paint until used |
| Local-first repositories | `src/app/core/repos/*`, `core/db/idb.ts` | Offline working copy and signal state |
| Shared contract as source of truth | `src/app/core/api/contracts.ts`, `docs/backend-contract.md` | Backend, mock and HTTP client agree on shapes/routes |
| Route-scoped repo shadowing | `src/app/app.routes.ts`, `src/app/core/visit/*` | Visit/co-gardening writes target the visited forest |
| Generated deploy config | `tools/generate-config.mjs`, `src/app/core/generated-config.ts` | AWS builds consume immutable backend SSM handoff |

## Known Architectural Risks

- Login is wired but `requireAuth` remains false in the checked-in local config and `dev`; AWS go-live requires an intentional flip for test/prod builds.
- The README states live GitHub Pages remains available during migration while AWS delivery is prepared behind gates; production state depends on deployment gate settings not visible from local files.
- The app has many verification scripts; change safety depends on running the right subset or `tools/run-battery.mjs`, not just unit tests.

## Evidence

- `README.md`
- `AGENTS.md`
- `docs/aws-connect.md`
- `docs/backend-contract.md`
- `src/main.ts`
- `src/app/app.config.ts`
- `src/app/app.routes.ts`
- `src/app/core/config.ts`
- `src/app/core/generated-config.ts`
