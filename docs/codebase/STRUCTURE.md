# Codebase Structure

## Top-Level Map

| Path | Purpose | Evidence |
|------|---------|----------|
| `.github/workflows/` | CI, legacy Pages deploy, AWS dev/promote/rollback/preflight | `.github/workflows/*.yml` |
| `.vscode/` | Local editor launch/task hints | `.vscode/*` |
| `docs/` | AWS handoff, backend contract, manual/user docs | `README.md`, `docs/*.md` |
| `plan/` | Original design notes/prototypes | `README.md`, `plan/*` |
| `public/` | PWA icons, manifest, `sw.js` wrapper | `angular.json`, `public/` |
| `src/app/core/` | DB, repos, auth/API seams, sync, i18n, theme, boot/update services | `AGENTS.md`, `src/app/core/*` |
| `src/app/features/` | Route-level product features | `AGENTS.md`, `src/app/app.routes.ts` |
| `src/app/shared/` | Shared UI primitives | `AGENTS.md`, `src/app/shared/ui/` |
| `tools/` | Config, hosting, smoke, screenshots, verification battery | `AGENTS.md`, `tools/*.mjs` |

## Entry Points

- Main runtime entry: `src/main.ts`.
- Angular app config: `src/app/app.config.ts`.
- Routes: `src/app/app.routes.ts`.
- Service worker entry: `public/sw.js`, registered by `provideServiceWorker('sw.js')`.
- Config generator entry: `tools/generate-config.mjs`.

## Module Boundaries

| Boundary | What belongs here | What must not be here |
|----------|-------------------|------------------------|
| `core/db` | IndexedDB schema/wrapper/broadcast | UI copy or network calls |
| `core/repos` | Signal repositories and local persistence facades | AWS SDK code |
| `core/api` | API contract, mock executable spec, HTTP client seam | Feature templates |
| `core/auth` | Mock/Cognito auth providers and auth facade | Route-specific UI |
| `features/*` | User-facing flows and route components | Direct network calls outside seams |
| `tools/` | Build/deploy validation and browser probes | Runtime app code |

## Naming and Organization Rules

- File naming pattern: mostly kebab-case for multiword files (`generated-config.ts`, `tree-layout.ts`) and concise feature names (`ahora.ts`, `forest.ts`).
- Directory organization pattern: core-by-capability plus feature-by-route.
- Import aliasing: no app path alias found in `tsconfig.json`; imports are relative.

## Evidence

- `README.md`
- `AGENTS.md`
- `angular.json`
- `src/main.ts`
- `src/app/app.config.ts`
- `src/app/app.routes.ts`
