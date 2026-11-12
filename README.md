# RoadMap2U 🌱

**A goal map that grows like a tree — built for neurodivergent minds.**

Goals are branches. Achieved ones bloom. Missed deadlines are never failures: they become **branch points** where new alternative paths grow. Every session opens with one gentle question: **"¿Dónde sientes que estás?"** (*Where do you feel you are?*) — and the journey continues from wherever you actually are.

**Live:** https://roadmap2u.com/

If you still have a forest saved on the [previous site](https://toydrum.github.io/RoadMap2U/), export a backup there and import it on the current site. Each address has its own local storage.

## Principles

- **No shame mechanics.** No streaks, no "overdue", no red alarms. A passed date offers three kind exits: keep going, move the date, or open a new branch.
- **Local-first & private.** Everything lives in your device (IndexedDB). Nothing leaves without you. JSON export/import for backups. The data model is sync-ready for an optional cloud future.
- **Low cognitive load.** One question per screen, everything skippable, predictable layout (the tree never reshuffles).
- **Accessible by design.** Full keyboard navigation on the tree (roving tabindex + arrow keys), adjustable text size, optional dyslexia-friendly font (Atkinson Hyperlegible), `prefers-reduced-motion` respected everywhere, ≥44px touch targets.
- **Two personalities.** Calm "garden" theme by default; opt-in retro **terminal** theme (the original 2024 pip-boy idea lives!).

## Tech

Angular 22 PWA — standalone components, signals, zoneless change detection. Zero UI libraries; the tree is hand-rolled SVG (pure layout function with deterministic organic jitter, bezier tapered edges, pointer pan/zoom + pinch). Hand-rolled ~100-line IndexedDB wrapper with signal-based repositories, atomic branch transactions, cross-tab sync via BroadcastChannel, and a two-layer migration system. Installable + offline via `@angular/service-worker`.

**Requirements:** Node.js ≥ 24.15 (26.x recommended) and npm 11+.

```bash
npm install
npm start          # dev server (SW disabled in dev)
npm run build      # production build into dist/

# Test the real root-hosted PWA with SPA fallback:
npx http-server dist/roadmap2u/browser -p 8080 -P "http://localhost:8080?"
# → http://localhost:8080/
```

## Structure

- `src/app/core/db/` — schema (sync-ready records with rev/tombstones), IDB wrapper, cross-tab broadcast
- `src/app/core/repos/` — signal repositories (write-through), backup/export
- `src/app/core/i18n/` — ES (source of truth) + EN dictionaries, typed parity
- `src/app/features/` — check-in ritual, forest, tree canvas, node detail, branch flow, timer, settings
- `plan/` — the original 2024 design notes this project grew from 🌳

The current GitHub Pages URL remains available during the origin-migration
window. Its workflow is manual-only; AWS delivery is prepared but disabled
until the mutually exclusive repository gates are deliberately changed from
`AWS_DEPLOY_ENABLED=false` and `AWS_ROLLBACK_ENABLED=false`.

### AWS frontend delivery

- Pull requests run config-contract tests, application tests, a root (`/`)
  production build, and the initial-bundle gate.
- A push to `main` deploys that exact SHA to `dev` when the AWS gate is
  enabled. Manual promotion accepts only a successful prior-stage SHA
  (`dev → test → prod`); rollback accepts only a successful same-stage SHA.
- Each GitHub Environment supplies `AWS_ACCOUNT_ID` and `AWS_ROLE_ARN`.
  Actions pins the expected account, uses OIDC, and keeps no
  long-lived AWS access keys. The manual OIDC preflight verifies only the
  assumed identity and performs no AWS mutation.
- Deployment values come from `/roadmap2u/<stage>/*` in SSM. The generated
  config rejects missing or malformed Cognito/API values, an API URL containing
  `/v1`, and a backend contract hash that differs from this checkout. Before
  every publish, the workflow proves that the active backend SHA has a matching
  successful release marker and consumes its immutable, SHA-versioned handoff
  manifest. It rechecks the active pointer after the build to avoid publishing
  across a backend release transition.
- Assets publish before `index.html`; only mutable PWA entrypoints are
  invalidated. Mutable artifacts are retained by SHA plus `current` and
  `previous`, and successful release markers are written only after smoke.

The AWS backend and infrastructure live in
[`Toydrum/roadmap2u-backend`](https://github.com/Toydrum/roadmap2u-backend).
See [`docs/aws-connect.md`](docs/aws-connect.md) for SSM paths, stage URLs,
GitHub variables, promotion, DNS transition, and rollback.

## For AI agents & new contributors

Read **[`AGENTS.md`](AGENTS.md)** first — it documents the non-negotiable product rules (compass language, no shame mechanics, determinism, motion care), the data-model semantics, the rendering system, the verification tooling and the deploy playbook. `CLAUDE.md` points there too.
