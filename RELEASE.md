# Release Log

Release history for the Intervals.icu MCP server. Newest first. Versions follow
[Semantic Versioning](https://semver.org/). The image tag in
`k8s/deployment.yaml` must be bumped on every release (it drives the ArgoCD sync).

## [Unreleased] — 0.1.0

Initial implementation. Not yet deployed.

### Added
- TypeScript MCP server scaffold (plain `tsc` ESM build), mirroring the
  fatsecret-mcp / hevy-mcp reference pattern.
- Streamable HTTP transport with OAuth 2.1 + PKCE (`src/http-server.ts`,
  `src/oauth-provider.ts`) and a stdio entry point for local debugging.
- Hand-written typed Intervals.icu client (`src/intervals-client.ts`) with
  descriptive error surfacing on non-2xx responses.
- Coaching business logic (`src/business.ts`): Rule 1 WeightTraining load,
  overreachRisk / fatigueSpike / hrvTrendDown flags.
- 16 tools — Phase 1 (10), Phase 2 (2), Phase 3 (4, incl. `list_plan_folders`).
- `openapi-spec.json` committed as the field-name source of truth.
- Dockerfile, k8s manifests (`k8s/`), and ArgoCD Application (`deploy/argocd/`).
- Antora ROOT-module documentation (requirements, design, decision log).

### Live read-validation (2026-06-02)
All read tools verified against the live API for athlete i579914:
- `get_power_curves`: the endpoint works with just `type` + date range (the
  spec's required `f1`/`f2`/`f3` are tolerated absent). Output is projected to the
  standard durations (5s/1min/5min/20min/60min) with watts and W/kg. Resolved.
- `eftp` is sourced from `wellness.sportInfo[].eftp` (not a top-level field). Resolved.
- `get_events` `completed` flag: `paired_activity_id` IS returned and populated. Resolved.
- PMC floats are rounded (CTL/ATL to 1dp, ramp rate to 2dp).

### Still to validate before retiring IcuSync
- Write tools (`push_workout`, `update_event`, `push_note`, `push_weekly_target`,
  `update_activity`, `create_activity`, `apply_plan`) — validate in the
  Intervals.icu UI (not exercised live to avoid polluting the calendar).
  In particular confirm the event `start_date_local` format and the `push_note`
  week-row rendering round-trip.
- All tools to be compared against IcuSync per the handover validation table.
