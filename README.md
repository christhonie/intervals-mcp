# Intervals.icu MCP

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Intervals.icu](https://intervals.icu) training API, built as a **claude.ai custom
connector**. It exposes coaching-focused tools (fitness/PMC metrics, training
history, calendar workouts, wellness, week-row notes, and Plan Builder targets)
with the coaching business logic embedded server-side, so the assistant gets a
complete result from a single tool call.

It replaces the commercial **IcuSync** managed MCP, adding capabilities IcuSync
cannot provide: week-row calendar notes, writes to completed activities, and
Plan Builder `TARGET`/`PLAN`/`apply-plan` integration.

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
| `get_power_curves` | 1 | ⚠ endpoint params need live validation |
| `get_training_summary` | 1 | volume/load aggregates |
| `update_activity` | 2 | write load/description to a completed activity |
| `create_activity` | 2 | manual activity, `source=MANUAL` |
| `get_weekly_targets` | 3 | Plan Builder `TARGET` + compliance calc |
| `push_weekly_target` | 3 | write/update a weekly `TARGET` |
| `list_plan_folders` | 3 | discover `folder_id` for `apply_plan` |
| `apply_plan` | 3 | apply a plan folder to the calendar (Monday start) |

### Business rules (server-side)

- **Rule 1 — WeightTraining load:** when `rpe` and `duration_minutes` are supplied
  without an explicit `icu_training_load`, load = `round(rpe × minutes × 0.15)`.
  Never auto-computed for power/HR sports (it would corrupt TSS).
- **Tags** pass through unchanged.

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

## License

MIT — see [LICENSE](LICENSE).
