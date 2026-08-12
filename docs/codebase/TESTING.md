# Testing

## Test Setup

| Area | Value | Evidence |
|------|-------|----------|
| Angular tests | `npm test` -> `ng test` | `package.json`, `angular.json` |
| Config/tool tests | Node built-in test runner | `package.json`, `tools/*.test.mjs` |
| Browser verification | Playwright Core with local/system browser per `AGENTS.md` | `package.json`, `tools/verify-*.mjs`, `AGENTS.md` |
| CI | Config tests, app tests, root build, PWA validation, bundle grep | `.github/workflows/ci.yml` |

## Coverage Areas Observed

- Pure/domain specs under `src/app/core` and feature folders: cadence, heart, harvest, mock API family/social, almanac, finder/flora, tree layout/silhouette/labels.
- Tool tests cover config generation, hosting config, frontend smoke, built PWA validation and deployment target validation.
- Browser verification scripts under `tools/verify-*.mjs` cover many user flows.

## Mocking Strategy

- Local default uses `MockApi` and `MockAuthProvider` through lazy seams in `app.config.ts`.
- Mock cloud uses separate IndexedDB database `roadmap2u-mockcloud`.
- `AGENTS.md` says the mock is the executable backend spec until AWS go-live.

## Useful Commands

```powershell
npm run test:config
npm test -- --watch=false
npm run build -- --base-href /
node tools/validate-built-pwa.mjs --build-dir dist/roadmap2u/browser
node tools/run-battery.mjs
```

## Gaps

- Frontend test discovery is managed by Angular; there is no root `vitest.config.ts`.
- No coverage threshold config is versioned.
- The browser battery requires a built app and system Edge, so unit tests alone do not cover the interactive flows.

## Evidence

- `package.json`
- `angular.json`
- `.github/workflows/ci.yml`
- `AGENTS.md`
- `src/app/app.config.ts`
- `src/**/*.spec.ts`
- `tools/*.test.mjs`
- `tools/run-battery.mjs`
