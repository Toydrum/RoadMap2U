# Connecting RoadMap2U to AWS

This is the frontend handoff for the serverless backend in
[`Toydrum/roadmap2u-backend`](https://github.com/Toydrum/roadmap2u-backend).
Infrastructure is owned and deployed from that repository. The frontend never
stores AWS credentials and its deployed configuration is generated from SSM;
there is no manual output-copying step.

## Deployment state

The workflows and validation gates are prepared, but AWS deployment remains
disabled until the backend stack is deployed. Normal delivery requires exactly
`AWS_DEPLOY_ENABLED=true` and `AWS_ROLLBACK_ENABLED=false`; rollback requires
exactly the inverse. Both variables start as `false`, and every other
combination prevents mutation. No infrastructure resources are created by the
frontend repository.

| Stage | Frontend | API | Region |
|---|---|---|---|
| `dev` | `https://dev.roadmap2u.com` | `https://api.dev.roadmap2u.com` | `us-east-1` |
| `test` | `https://test.roadmap2u.com` | `https://api.test.roadmap2u.com` | `us-east-1` |
| `prod` | `https://roadmap2u.com` | `https://api.roadmap2u.com` | `us-east-1` |

The backend stack owns Cognito, API Gateway, Lambda, DynamoDB, the S3 frontend
bucket, CloudFront, certificates, DNS integration, OIDC roles, and the SSM
handoff. The frontend bucket name is deterministic:
`roadmap2u-<stage>-<AWS_ACCOUNT_ID>`.

## SSM handoff

Each backend stage publishes these values:

```text
/roadmap2u/<stage>/region
/roadmap2u/<stage>/user-pool-id
/roadmap2u/<stage>/user-pool-client-id
/roadmap2u/<stage>/api-base-url
/roadmap2u/<stage>/frontend-bucket
/roadmap2u/<stage>/cloudfront-distribution-id
/roadmap2u/<stage>/frontend-url
/roadmap2u/<stage>/contract-hash
/roadmap2u/<stage>/backend-releases/<40-character-sha>
/roadmap2u/<stage>/backend-release-manifests/<40-character-sha>
/roadmap2u/<stage>/backend-release-sha
```

The individual handoff parameters remain useful for operators and diagnostics,
but frontend publication reads configuration from the immutable release
manifest selected by `backend-release-sha`. The manifest binds
`schemaVersion`, `stage`, `backendReleaseSha`, and all eight handoff values in a
single SSM value. The matching marker and manifest are written before the
active pointer moves, so a frontend build cannot combine values from two
backend releases.

Successful frontend releases are recorded separately:

```text
/roadmap2u/<stage>/frontend-releases/<40-character-sha>
/roadmap2u/<stage>/frontend-release-sha
```

`tools/generate-config.mjs` reads the handoff through workflow environment
variables and replaces `src/app/core/generated-config.ts` for that build. It
rejects a wrong stage/host, anything outside `us-east-1`, an API URL containing
`/v1`, malformed Cognito identifiers, and contract drift. The checked-in
generated config remains the offline mock default.

The contract digest is stable across operating-system line endings. For each
file below, in order, hash its UTF-8 relative path, NUL, CRLF-to-LF-normalized
text, then NUL:

1. `api/contracts.ts`
2. `db/schema.ts`
3. `auth/auth-types.ts`

Byte-for-byte parity of the vendored backend files is a separate check; see
[`backend-extraction.md`](./backend-extraction.md).

## GitHub configuration

Create GitHub Environments named `dev`, `test`, and `prod`. Configure:

- Repository variables `AWS_DEPLOY_ENABLED=false` and
  `AWS_ROLLBACK_ENABLED=false` until the corresponding operation is approved.
- Environment variable `AWS_ACCOUNT_ID` in each stage with the exact 12-digit account.
- Environment variable `AWS_ROLE_ARN` in each stage, pointing to
  `roadmap2u-<stage>-frontend-deploy`.
- Required reviewers for `test`/`prod` as appropriate.

Actions exchanges GitHub's OIDC token for short-lived credentials. Every AWS
workflow pins `allowed-account-ids`, checks `sts:GetCallerIdentity` before SSM
or S3 access, and validates that the SSM bucket, URL, CloudFront distribution,
alias, S3 origin, region, and Origin Access Control all belong to the selected
stage. Run `.github/workflows/oidc-preflight.yml` first for each environment;
it obtains the OIDC session, calls only `sts:GetCallerIdentity`, and neither
checks out code nor writes AWS state.

## Delivery flow

1. `.github/workflows/ci.yml` runs configuration tests, Angular tests, a
   root-hosted production build, local PWA validation, and the initial-bundle
   provider-signature gate.
2. A commit on `main` deploys that exact SHA to `dev` when the normal-delivery
   gate pair is enabled.
3. `.github/workflows/promote-aws.yml` accepts only an exact lowercase
   40-character SHA. `test` requires its successful `dev` marker; `prod`
   requires its successful `test` marker. The marker is checked before
   checkout.
4. `.github/workflows/rollback-aws.yml` accepts only a SHA already marked
   successful in the same stage. Its default `recovery_mode=rebuild` regenerates,
   rebuilds, validates, and republishes compatible source. With
   `recovery_mode=snapshot`, it downloads the retained original PWA, checks every
   service worker asset hash and the API/Cognito destination, validates the PWA,
   and republishes those bytes. Snapshot mode checks out the exact workflow SHA
   for recovery tools; it does not compile the prior frontend contracts.
5. Before configuration generation or upload, each workflow reads
   `/backend-release-sha`, validates its matching `/backend-releases/<sha>`
   proof and `/backend-release-manifests/<sha>` snapshot, and records the
   backend SHA, frontend SHA, and contract hash in the Actions summary. The
   backend pointer is checked again after the build and immediately before
   publication.
6. A release marker and current pointer are written only after the remote
   frontend/API smoke passes.

Publication uploads immutable assets first and the live `index.html` last.
Mutable PWA files are retained under the release SHA, `releases/current`, and
`releases/previous`, in addition to S3 versioning. CloudFront invalidation is
limited to mutable entrypoints.

Before DNS cutover, the production smoke uses the distribution's
`*.cloudfront.net` hostname while the GitHub Environment URL remains the
canonical `https://roadmap2u.com`. Development and test smoke their canonical
stage hosts.

## Backend and browser requirements

- Cognito uses username sign-in, a public SPA client without a secret,
  `ALLOW_USER_SRP_AUTH`, code-based verification/recovery, and the password
  policy in `auth-types.ts`.
- The HTTP API validates Cognito ID tokens and exposes routes beneath `/v1`;
  the SSM `api-base-url` never includes `/v1`.
- Production CORS allows only `https://roadmap2u.com`. Dev and test allow
  their canonical stage origin plus exactly `http://localhost:4200` and
  `http://localhost:8826`. The legacy Pages origin is not an AWS production
  origin.
- `aws-amplify` remains behind the lazy authentication seam. The initial
  `main-*.js` must not match, case-insensitively,
  `cognito-idp|amazonaws.com|aws-amplify|Cognito`.
- `/v1/me` without a token must return `401` with a JSON body.

## Cutover and rollback

Keep `.github/workflows/deploy.yml` manual-only while users move from the
legacy GitHub Pages origin. Enable AWS delivery only after the backend CI,
CloudFront bindings, SSM handoff, CORS, and stage smokes are green. DNS cutover
is an infrastructure operation in the backend repository.

For application rollback, temporarily set `AWS_DEPLOY_ENABLED=false` and
`AWS_ROLLBACK_ENABLED=true`, then dispatch `rollback-aws.yml` with the stage and
a same-stage successful SHA. Choose `recovery_mode=snapshot` when the earlier
client contracts cannot be rebuilt against the current backend manifest.
Verify the retained artifact before the release window: downloads use
conditional `GetObject` requests with the observed ETag, and the receipt stays
outside the publish directory. A missing, changed, corrupt, or differently
configured artifact stops recovery before any upload. The existing publication
script retains the previous mutable files, publishes assets first and index
last, then invalidates CloudFront; the stage pointer changes only after smoke.
Snapshot reads use the role's existing `s3:GetObject` permission. Restore both
gates to `false` afterward. For a
broader infrastructure incident, leave the frontend release markers intact and
follow the backend repository's rollback runbook; never replace generated
configuration with hand-edited values.
