# Intervals.icu MCP — Project Guide for Claude

A remote (Streamable HTTP) MCP server for the Intervals.icu training API, built
as a **claude.ai custom connector**. Coaching business logic lives server-side so
the assistant gets a complete result from a single tool call. It runs in parallel
with (and is replacing) the commercial **IcuSync** managed MCP.

## Single source of truth — the handover document

The authoritative spec for this project is the **Outline handover doc**, not this
repo. Read it in full before starting any phase of work:

- **URL:** kept out of this public repo. Find the handover doc in the Outline
  workspace (search its title, "Claude Code Handover — Custom Intervals.icu MCP
  Server"), or read it from your local untracked notes.
- Access it via the **Outline MCP** (`fetch` with `resource: document`). It is
  large (~125 KB) — fetching returns a saved file path; extract the markdown with
  `jq -r '.[].text'` and grep for the phase/section you need rather than reading
  all of it.
- The doc's **"Next Session Prompt"** (top of the doc, dated) supersedes all
  earlier prompts and names the only outstanding work. The doc instructs you to
  **update that section in place** (via the Outline MCP) with fix detail and
  status as you complete each item — don't report only in chat.

The repo's `RELEASE.md` and `docs/.../decision-log.adoc` reference "the handover
document" but do not contain it. If a task mentions a "Phase N" or "CR-NN" you
can't find in the repo, it's in the Outline doc.

## How work is structured

- Work is organised into **Phases** (1–9 so far) and **CRs/BUGs**, all defined in
  the handover doc. Each shippable change gets a **semver release**.
- **`RELEASE.md`** is the per-release changelog (newest first) — add an entry for
  every release.
- **`docs/modules/ROOT/pages/decision-log.adoc`** holds ADRs (ADR-001…) and a
  requirement-change-log table. Add an ADR when a phase involves a non-obvious
  design decision (e.g. an API-shape discovery). `requirements.adoc` documents
  Phases 1–3 only; later phases live in RELEASE.md + ADRs.
- Activity IDs are normalised to the `i`-prefixed form. Dates sent to the events
  API need a full ISO datetime (`toDateTime` appends `T00:00:00`).

## Architecture / key files

- `src/server.ts` — all tool definitions, grouped `registerPhaseN()`. `VERSION`
  const lives here (keep in sync with `package.json`).
- `src/schemas.ts` — Zod input shapes (raw `ZodRawShape`, not `z.object()`).
- `src/intervals-client.ts` — hand-written typed API client (~10 endpoints).
  `openapi-spec.json` is the committed field-name source of truth (we do **not**
  generate the client — see ADR-003).
- `src/business.ts` — Rule 1 load calc + readiness flags. `src/dates.ts` — date
  helpers.
- `src/http-server.ts` / `src/oauth-provider.ts` / `src/oauth-store.ts` —
  Streamable HTTP transport + OAuth 2.1/PKCE (claude.ai connectors require the
  server to be its own OAuth authorization server). Optional Redis token
  persistence via `REDIS_URL`.

## Business rules (baked into write tools)

- **Rule 1 (WeightTraining only):** when `rpe` + `duration_minutes` are supplied
  without an explicit `icu_training_load`, load = `round(rpe × minutes × 0.15)`.
  **Never** auto-computed for Ride/VirtualRide etc. — it would corrupt TSS.
- **Tags** pass through unchanged.
- **Preview-by-default** guard on the riskiest writes (`update_sport_settings`,
  `update_activity_type`): without `confirm: true` they return a diff and write
  nothing.
- Event colours: PLAN events require **bare hex** (no `#`); the `#` is stripped
  before sending (`stripHash`). NOTE events tolerate `#`.

## Build / test / deploy

```bash
npm install
npm run type-check      # tsc --noEmit
npm run build           # tsc → dist/
npm run inspect         # MCP Inspector against dist/index.js (stdio)
```

Deploy is **container + Kubernetes (namespace `mcp`) via ArgoCD**, and the
build/push/tag-bump is **automated on merge to `main`** by
`.github/workflows/release.yml` (see `docs/modules/ROOT/pages/cicd.adoc`):

1. Bump `VERSION` in `src/server.ts` **and** `version` in `package.json`. The
   image tag IS that version — one version = one release.
2. Merge to `main`. The workflow then builds & pushes
   `docker.io/christhonie/intervals-mcp:<version>`, rewrites the
   **`k8s/deployment.yaml`** image tag, and commits it back — which is what drives
   the ArgoCD sync. **Do not** build/push or edit the manifest tag by hand.
3. After rollout, **reconnect the connector / start a new conversation**: MCP
   sessions are in-memory per pod, so claude.ai may hold a stale `Mcp-Session-Id`
   (404 "Unknown session") until reconnect. With `REDIS_URL` set, OAuth tokens
   survive rollouts so no re-auth is needed — only a session reconnect.
- Requires a `DOCKER_PAT` repo secret (Docker Hub PAT). Manual redeploy of the
  current version is available via the workflow's `workflow_dispatch` trigger.
- Target endpoint: `https://icu-mcp.christhonie.co.za/mcp` · athlete `ixxxxx`.
- The deployed server (reachable via the `Intervals_MCP` / `IcuSync` connectors)
  reflects the **last deployed image**, not local working-tree changes — you can't
  live-test a new tool until it's deployed.

## Git

- Recent phases were committed straight to `main`; prefer a `feature/*` branch for
  new work and commit per the global git conventions.
- Co-author trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
