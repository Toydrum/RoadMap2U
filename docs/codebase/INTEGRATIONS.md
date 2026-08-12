# Integrations

## External Services

| Integration | Role | Evidence |
|-------------|------|----------|
| Browser IndexedDB | Primary local data store and mock cloud store | `src/app/core/db/idb.ts`, `src/app/core/api/mock-cloud.ts` |
| BroadcastChannel | Cross-tab data/auth/session propagation | `src/app/core/db/broadcast.ts`, `src/app/core/auth/auth.service.ts` |
| Angular service worker | Installable/offline PWA with wrapper `sw.js` | `angular.json`, `ngsw-config.json`, `public/sw.js`, `app.config.ts` |
| AWS Cognito via Amplify | Real auth adapter for AWS builds | `package.json`, `src/app/core/auth/cognito-auth.provider.ts` |
| RoadMap2U backend API | `/v1` sync/family/friends/forest/me endpoints | `docs/backend-contract.md`, `src/app/core/api/http-api.ts` |
| AWS SSM handoff | Build-time config source in GitHub Actions | `docs/aws-connect.md`, `tools/read-backend-release.sh`, `tools/generate-config.mjs` |
| S3/CloudFront | AWS frontend hosting target | `docs/aws-connect.md`, `tools/publish-aws-site.sh` |
| GitHub Pages | Legacy migration-window origin | `README.md`, `.github/workflows/deploy.yml` |

## Credentials and Secrets

- Checked-in config is mock-safe and contains empty AWS values.
- AWS deploy workflows use GitHub OIDC and `AWS_ROLE_ARN`/`AWS_ACCOUNT_ID`; no long-lived AWS key path was found.
- `tools/generate-config.mjs` validates generated public config and contract hash before build.

## Observability and Analytics

- No analytics, ads, or tracking are allowed according to `AGENTS.md`.
- No third-party monitoring/APM integration was found.
- Smoke/verification scripts are the main operational feedback mechanism.

## Evidence

- `AGENTS.md`
- `docs/aws-connect.md`
- `docs/backend-contract.md`
- `src/app/core/generated-config.ts`
- `src/app/core/auth/cognito-auth.provider.ts`
- `src/app/core/api/http-api.ts`
- `tools/generate-config.mjs`
- `.github/workflows/deploy-aws-dev.yml`
