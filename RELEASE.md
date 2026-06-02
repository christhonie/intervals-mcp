# Release Log

Release history for the Intervals.icu MCP server. Newest first. Versions follow
[Semantic Versioning](https://semver.org/). The image tag in
`k8s/deployment.yaml` must be bumped on every release (it drives the ArgoCD sync).

## 0.1.2 — 2026-06-02

### Added
- `push_sport_targets`: set per-sport weekly targets. Investigation established
  that the API has no nested per-sport field on a TARGET event — per-sport
  targets are **separate TARGET events per sport per week** (each with `type`,
  `load_target`, `time_target`, `distance_target`, and `description` as the
  coaching note). The tool replaces all TARGET events in a week (delete-then-
  recreate) with one per supplied sport. `distance_m` is supported but optional.

### Changed
- `get_weekly_targets` now groups TARGET events by week and returns a
  `sport_targets[]` array per week (type, load_target, duration_minutes,
  distance_m, notes), with the week `load_target` as the sum across sports.
  Week-level `current_week`/`completed_load`/`compliance` are unchanged;
  `phase_name` is preserved when a target's name is not itself a sport type.

### Notes
- Rollout is staged: a single pilot week is restructured first for UI
  verification before the remaining weeks (per operator decision).
- Pilot week 2026-06-01 applied and UI-verified (Ride + WeightTraining render
  separately with a combined header total). The remaining 27 weeks are delegated
  to a separate session, driven by the value table in the handover document.

## 0.1.1 — 2026-06-02

### Fixed
- `push_weekly_target`: replacing an existing Plan Builder TARGET event now works.
  Three API behaviours were discovered and handled:
  1. The API rejects `PUT` on TARGET events with
     `HTTP 422 "Cannot change TARGET date"` — even when the date is unchanged.
     `DELETE /events/{eventId}` is permitted, so an update (when `event_id` is
     supplied) is now done by **delete-then-recreate**: DELETE the existing event,
     then POST a new TARGET (`end_date_local = week_start + 7`, exclusive). The
     delete tolerates `404` (already removed) so the operation is idempotent. The
     recreated event gets a new id (returned as `created`).
  2. Creating a TARGET requires a `type` (`HTTP 422 "type is required for
     category TARGET"`). Plan Builder weekly targets use `type: "Ride"`, now set.
  3. Event POSTs require a full ISO datetime for `start_date_local` /
     `end_date_local` (a bare `YYYY-MM-DD` is rejected with "Invalid start date").
- Event date format: added a `toDateTime` helper that appends `T00:00:00` to
  date-only values. Applied to `push_weekly_target`, **and also to `push_workout`
  and `push_note`**, which had the same latent date-format bug on POST.

### Operational
- Applied the corrected 28-week load targets (Base 12w + Build 16w,
  2026-05-04 → 2026-11-15) via the new replace path; validated all 28 with
  `get_weekly_targets` (loads + phases match, no discrepancies).
- Image bumped to `0.1.1`; `k8s/deployment.yaml` updated.

## 0.1.0 — 2026-06-02

Initial implementation. Deployed to `https://icu-mcp.christhonie.co.za/mcp`.

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
