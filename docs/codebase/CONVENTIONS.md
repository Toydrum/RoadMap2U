# Coding Conventions

## Naming and Layout

| Convention | Observed rule | Evidence |
|------------|---------------|----------|
| Files | Mostly kebab-case for multiword files and short Spanish/domain feature names | `src/app/core/generated-config.ts`, `src/app/features/ahora/ahora.ts` |
| Components/services/classes | PascalCase | `src/app/app.config.ts`, `src/app/app.routes.ts` |
| Signals/services | Angular injection and signal-based services | `src/app/app.config.ts`, `AGENTS.md` |
| Tests | `*.spec.ts` beside source; Node tests as `*.test.mjs` in `tools/` | `src/**/*.spec.ts`, `tools/*.test.mjs` |

## Formatting and TypeScript

- TypeScript config enables `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `isolatedModules`, and Angular strict injection/input options.
- `.prettierrc` and `.editorconfig` exist.
- No ESLint config was found by scan or file search.

## Product and UI Conventions

- `AGENTS.md` defines non-negotiable rules: no shame mechanics, deterministic visuals, bilingual copy, privacy/local-first, motion care, and modal `appSheet`.
- User-facing copy belongs in `core/i18n/es.ts` and `en.ts`; hardcoded template strings are disallowed by `AGENTS.md`.
- Network calls are constrained to `core/api` and `core/auth` by `AGENTS.md`.

## Error Handling

- HTTP API adapter maps backend/client errors through contract-defined codes in `core/api/http-api.ts`.
- Auth errors are mapped in `core/auth/cognito-auth.provider.ts`.
- Boot has a fail-open/error surface note in `core/boot.service.ts`.

## Imports

- Relative imports are used; no TypeScript path alias is configured.
- `aws-amplify` is dynamically imported only inside `core/auth/cognito-auth.provider.ts` per `AGENTS.md` and CI bundle grep.

## Evidence

- `AGENTS.md`
- `tsconfig.json`
- `.prettierrc`
- `.editorconfig`
- `src/app/core/i18n/es.ts`
- `src/app/core/auth/cognito-auth.provider.ts`
- `src/app/core/api/http-api.ts`
