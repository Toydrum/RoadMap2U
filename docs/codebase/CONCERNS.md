# Codebase Concerns

## Top Risks

| Severity | Concern | Evidence | Impact | Suggested action |
|----------|---------|----------|--------|------------------|
| high | Product rules are extensive and easy to violate with narrow UI edits | `AGENTS.md` | Small changes can break no-shame, privacy, bilingual, motion or deterministic behavior | Read `AGENTS.md` before each feature change and test touched flows |
| high | AWS delivery is prepared but gated/disabled in docs | `README.md`, `docs/aws-connect.md`, `.github/workflows/deploy-aws-dev.yml` | Local code does not prove live AWS deployment is active | Verify GitHub variables and backend SSM release state before release work |
| med | `requireAuth` is stage-dependent and checked-in config is mock/local | `src/app/core/generated-config.ts`, `tools/generate-config.mjs` | A build with wrong config could expose wrong auth mode or endpoint | Use only generated config from SSM in AWS workflows |
| med | Initial bundle must not include AWS provider code | `.github/workflows/ci.yml`, `app.config.ts`, `AGENTS.md` | Privacy/performance regression if lazy seam is broken | Keep Amplify behind dynamic import and run bundle grep |

## Technical Debt

| Debt item | Why it exists | Where | Risk if ignored | Suggested fix |
|-----------|---------------|-------|-----------------|---------------|
| Many flow-specific verification scripts | Visual/product behavior is high-context | `tools/verify-*.mjs`, `AGENTS.md` | Tests can drift or the wrong subset can miss regressions | Use `tools/run-battery.mjs` for release checks |
| Legacy GitHub Pages remains during migration | Users may still have local data on old origin | `README.md`, `.github/workflows/deploy.yml` | Confusion between legacy and AWS delivery | Keep origin-migration state explicit in release notes/runbooks |
| Contract source lives in frontend but backend vendors copies | Backend must compile independently | `docs/backend-extraction.md`, `docs/backend-contract.md` | Drift breaks API compatibility | Change frontend contract/mock first, then sync backend |

## Security Concerns

| Risk | OWASP category | Evidence | Current mitigation | Gap |
|------|----------------|----------|--------------------|-----|
| Cloud/API code leaking into initial bundle | N/A | `.github/workflows/ci.yml`, `AGENTS.md` | CI grep checks `cognito-idp|amazonaws.com|aws-amplify|Cognito` in `main-*.js` | Must rerun after auth/API seam edits |
| Wrong AWS deploy target | A05 Security Misconfiguration | `docs/aws-connect.md`, `tools/validate-deployment-target.mjs` | Workflows validate account, region, URL, bucket, CloudFront binding | Requires real GitHub/AWS environment verification |
| Privacy boundary on visits/sync | A01 Broken Access Control | `docs/backend-contract.md`, `src/app/core/visit/*`, `src/app/core/api/http-api.ts` | Route-scoped repos and backend contract strip private fields | Needs regression tests when visit/edit behavior changes |

## Performance and Scaling Concerns

| Concern | Evidence | Current symptom | Scaling risk | Suggested improvement |
|---------|----------|-----------------|-------------|-----------------------|
| Initial bundle budget is guarded but feature set is large | `angular.json`, `.github/workflows/ci.yml` | No symptom observed in files | Lazy imports can regress if new providers are eagerly imported | Keep feature/provider chunks lazy and watch CI budget |
| Browser persistence depends on IndexedDB availability | `src/app/core/db/idb.ts`, `AGENTS.md` | Known sandbox/headless trap documented | Private/sandboxed contexts can fail persistence assumptions | Verify persistence in real browser for storage changes |

## Fragile/High-Churn Areas

| Area | Why fragile | Churn signal | Safe change strategy |
|------|-------------|-------------|----------------------|
| `tools/` deploy/verification scripts | Release safety depends on them | 43 smoke/validate/verify scripts counted | Run config tests and relevant battery subset |
| `src/app/core/api` and `src/app/core/auth` | Contract/auth seams bridge mock and AWS | Contract docs and lazy seam rules | Change mock, HTTP and tests together |
| `src/app/features/forest` | Complex deterministic rendering and interaction | Many specs and verify scripts | Use browser probes, not unit tests only |

## `[ASK USER]` Questions

1. [ASK USER] Is GitHub Pages still the user-facing production origin today, or has any AWS stage been enabled?
2. [ASK USER] Should `requireAuth=true` be treated as a near-term go-live task, or only after a separate local-data migration plan?
3. [ASK USER] Which browser/viewport battery is mandatory before the first active development release?

## Evidence

- `README.md`
- `AGENTS.md`
- `docs/aws-connect.md`
- `docs/backend-extraction.md`
- `.github/workflows/*.yml`
- `src/app/core/generated-config.ts`
- `tools/run-battery.mjs`
