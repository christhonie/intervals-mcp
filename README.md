# Intervals.icu MCP

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)
![MCP](https://img.shields.io/badge/Model_Context_Protocol-1.27-purple.svg)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Intervals.icu](https://intervals.icu) training API, built as a **claude.ai custom
connector**. It exposes coaching-focused tools (fitness/PMC metrics, training
history, calendar workouts, wellness, week-row notes, Plan Builder targets, raw
activity streams, and a signal-analysis toolkit) with the coaching business logic
embedded server-side, so the assistant gets a complete result from a single tool
call.

It's built as an alternative to existing Intervals.icu MCP servers, adding
capabilities they typically don't expose: week-row calendar notes, writes to
completed activities, and Plan Builder `TARGET`/`PLAN`/`apply-plan` integration.

> **Status — personal deployment.** This is a single-athlete deployment built
> around one coaching workflow (the athlete ID and OAuth client are configured
> per-instance), not a turn-key multi-tenant service. The source is shared as a
> reference for others building Intervals.icu MCP servers — self-hosting is
> possible but assumes you're comfortable with the OAuth 2.1 + Kubernetes setup
> described below. There is no public hosted endpoint.

## Credits

This project was **built from scratch in TypeScript**, but it stands on the
shoulders of the Intervals.icu MCP community. Credit and thanks to:

- **[hhopke/intervals-icu-mcp](https://github.com/hhopke/intervals-icu-mcp)** (MIT)
  — the most mature community server (Python/FastMCP). Used as the reference for
  endpoint coverage, tool naming, and parameter shapes.
- **[VSidhArt/intervals-mcp](https://github.com/VSidhArt/intervals-mcp)** — for
  the OpenAPI-spec exploration approach.

We built fresh rather than forking because claude.ai remote connectors require
the server to be an **OAuth 2.1 + PKCE authorization server** (no bearer-token
option in the connector UI), which the community servers do not implement — that
layer is reused from our own `fatsecret-mcp` / `hevy-mcp` deployments. See
[the decision log](docs/modules/ROOT/pages/decision-log.adoc) for the full rationale.

## Architecture

```
                  OAuth 2.1 + PKCE              HTTP Basic (API_KEY:key)
claude.ai ─────► /authorize, /token ──────► /mcp ─────────► intervals.icu API
                 (this server is the                │
                  authorization server)             │
                                          Deployment (1 replica, mcp namespace)
                                          envFrom: intervals-mcp-secrets
```

- **Transport:** Streamable HTTP (`src/http-server.ts`). A stdio entry
  (`src/index.ts`) is kept for local debugging.
- **Auth to claude.ai:** OAuth 2.1 + PKCE via the MCP SDK auth router and a
  minimal single-client provider (`src/oauth-provider.ts`).
- **Auth to Intervals.icu:** HTTP Basic — username literal `API_KEY`, password is
  the personal API key.
- **API client:** a small hand-written typed client (`src/intervals-client.ts`).
  The OpenAPI spec is committed as `openapi-spec.json` (the field-name source of
  truth); see the decision log for why we don't generate the client.

## Tools

<!-- TOOLS:START — generated check: `npm test` fails if this table drifts from the registered tools (test/readme-tools.test.ts). Edit the rows by hand; keep them in sync with src/server.ts. -->

| Tool | Phase | Notes |
|---|---|---|
| `get_fitness_metrics` | 1 | CTL/ATL/TSB/ramp/eFTP + overreachRisk/fatigueSpike flags |
| `get_training_history` | 1 | rides vs gymSessions, Strava stubs filtered |
| `get_activity_detail` | 1 | non-null fields only |
| `get_events` | 1 | category filter; `completed` flag |
| `get_wellness` | 1 | + `hrvTrendDown` flag |
| `push_workout` | 1 | applies Rule 1 (WeightTraining load) |
| `update_event` | 1 | applies Rule 1; infers type from existing event |
| `push_note` | 1 | week-row notes via `for_week` + exclusive `end_date_local` |
| `update_note` | 1 | in-place PUT update of an existing NOTE event |
| `get_power_curves` | 1 | best power efforts over standard durations; ⚠ endpoint params need live validation |
| `get_training_summary` | 1 | volume/load aggregates |
| `update_activity` | 2 | write load/description to a completed activity |
| `create_activity` | 2 | manual activity, `source=MANUAL` |
| `get_weekly_targets` | 3 | Plan Builder `TARGET` + compliance calc |
| `push_weekly_target` | 3 | write/update a weekly `TARGET` |
| `push_sport_targets` | 3 | per-sport weekly `TARGET`s (delete-then-recreate); empty array clears the week |
| `list_plan_folders` | 3 | discover `folder_id` for `apply_plan` |
| `apply_plan` | 3 | apply a plan folder to the calendar (Monday start) |
| `update_sport_settings` | 3 | FTP/LTHR/max-HR/zones — ⚠ preview-by-default (needs `confirm:true`) |
| `update_activity_type` | 3 | CTL/ATL contribution multipliers — ⚠ preview-by-default |
| `push_plan_block` | 9 | PLAN phase bar spanning the Plan page (bare-hex colour) |
| `get_activity_streams` | 10 | raw 1 Hz time-series (watts/hr/smo2/…), positionally aligned |
| `detect_threshold_crossings` | 11 | times a stream crosses a threshold value/direction |
| `detect_peaks_nadirs` | 11 | prominence-filtered local maxima/minima |
| `compute_epoch_stats` | 11 | per-epoch summary stats; `exclude_windows` |
| `compute_correlation_window` | 11 | Pearson `r` over a window, with optional lag scan |
| `detect_plateaus` | 11 | sustained stable/elevated periods |
| `smooth_stream` | 11 | trailing rolling-mean derived stream (returns a handle) |
| `compute_derivative` | 11 | 1st/2nd derivative derived stream |
| `extract_segment` | 11 | materialise raw/smoothed values over a window |
| `align_events_to_stream` | 11 | event-locked windows + mean response shape |

<!-- TOOLS:END -->

Phases 4–8 had no net new tools (covered by RELEASE.md and the decision log).
Phase 11 tools accept either a raw stream name or a derived handle (e.g.
`smo2~mean:10`), keeping the high-fidelity series server-side between calls.

### Business rules (server-side)

- **Rule 1 — WeightTraining load:** when `rpe` and `duration_minutes` are supplied
  without an explicit `icu_training_load`, load = `round(rpe × minutes × 0.15)`.
  Never auto-computed for power/HR sports (it would corrupt TSS).
- **Tags** pass through unchanged.
- **Preview-by-default** on the riskiest writes (`update_sport_settings`,
  `update_activity_type`): without `confirm:true` they return a diff and write
  nothing.
- **Event colours:** PLAN events require **bare hex** (the leading `#` is
  stripped); NOTE events tolerate `#`.

## Development

```bash
npm install
cp .env.sample .env   # fill in INTERVALS_API_KEY, INTERVALS_ATHLETE_ID, OAUTH_*
npm run type-check
npm run build
npm run start:stdio   # local stdio server
npm run inspect       # MCP Inspector
```

## Deployment

Container + Kubernetes (mcp namespace, ArgoCD/cert-manager/nginx). See
`k8s/`, `deploy/argocd/`, and the deployment runbook in the docs. Target
endpoint: `https://icu-mcp.christhonie.co.za/mcp`.

## Documentation

Requirements, design, and the decision log live under [`docs/`](docs/) as an
Antora ROOT module.

## OAuth state persistence (optional, Redis)

By default the OAuth provider keeps codes/tokens in memory, so a pod rollout
forces claude.ai to re-authenticate. Set `REDIS_URL` to persist them in Redis
instead — tokens then survive rollouts (no re-auth after a deploy). Unset =
in-memory. If Redis is unreachable the store degrades gracefully (behaves as
in-memory) rather than failing auth. See `src/oauth-store.ts`.

### Reusing this in other MCP servers (template)

`src/oauth-store.ts` is generic and the `MinimalOAuthProvider` changes carry no
Intervals-specific logic, so the pattern ports directly to the sibling MCP
servers (`fatsecret-mcp`, `hevy-mcp`):

1. Copy `src/oauth-store.ts` verbatim.
2. `npm install ioredis`.
3. In the provider, replace the in-memory `Map`s with the injected `OAuthStore`
   (codes/access/refresh) and make the methods `await` the store (see this
   repo's `src/oauth-provider.ts`).
4. In the HTTP entry point: `const store = createOAuthStore("<app>:oauth")` and
   pass `store` into the provider. **Use an app-unique prefix** so multiple
   servers can share one Redis without key collisions.
5. Add `REDIS_URL` to the app's K8s Secret (a distinct Redis DB number per app
   is recommended). `envFrom: secretRef` injects it automatically.

The MCP transport/session remains in-memory by design — this template persists
only the OAuth layer (the part that otherwise forces re-authentication).

## License

MIT — see [LICENSE](LICENSE).
