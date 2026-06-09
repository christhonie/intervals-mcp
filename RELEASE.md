# Release Log

Release history for the Intervals.icu MCP server. Newest first. Versions follow
[Semantic Versioning](https://semver.org/). The image tag in
`k8s/deployment.yaml` must be bumped on every release (it drives the ArgoCD sync).

## 0.1.12 — 2026-06-09

Phase 9 — PLAN phase-bar creation + `color` on `update_event`.

### Added
- **`push_plan_block`** — create a `category: PLAN` event (the coloured phase
  bars that span the Plan page above the weekly TARGET rows). The Plan Builder
  only generates these internally; this tool creates them directly via
  `POST /events`. `start_date`/`end_date` span the bar (end exclusive);
  `color` is bare hex (a leading `#` is stripped — PLAN bars reject `#rrggbb`),
  default `4caf50`; `type` is required by the API but cosmetic for PLAN events
  (default `Ride`). No Rule 1, no load fields, no `for_week`. Low-risk write
  (no confirm guard) — PLAN events are freely editable/deletable.

### Changed
- **`update_event` accepts an optional `color`** (hex, with or without `#`; the
  `#` is stripped before sending — bare hex is the PLAN convention and is valid
  on all event categories). Sent only when supplied, so an omitted `color` never
  clears an existing colour.

### Verification (Task 4 — no code change)
- `get_events(category=PLAN)` already works: `category` is a pass-through to the
  API and the event projection (since CR-01, 0.1.8) already returns `color`,
  `end_date_local`, and `for_week`. PLAN events come through on that same path.

### Outstanding (operational — not in this code change)
- **Deploy:** build/push image `0.1.12`, bump `k8s/deployment.yaml` image tag
  (drives ArgoCD), reconnect the connector after rollout.
- **Live verification of `push_plan_block`** (create a far-future test PLAN
  event, confirm the coloured bar renders, read back via `get_events`, delete).
- **Task 3 (data):** create the Phase 3 PLAN bar — `Phase 3 — Strength focus`,
  2026-10-12 → 2026-12-08 (excl.), colour `D85A30`, tag `phase-3`.
- **Phase 1 end-date fix:** shorten PLAN event 113776609 to end 2026-07-28
  (departure date, exclusive) via `update_event` (now that `color`/PUT path is
  in place).
  These three require the deployed 0.1.12 server (or a direct API call) and
  write to the live athlete calendar — held pending operator go-ahead.

## 0.1.11 — 2026-06-03

Weight Lifted field write support + Phase 8 outcome correction.

### Added
- **`kg_lifted` write support** on `update_activity` and `create_activity` — the
  total weight lifted (kg) for a strength session. Mirrors Intervals.icu's new
  "Weight Lifted" field (announced 2026-06-03; the `kg_lifted` API field already
  existed and `get_training_history` already read it). Verified live: create with
  `kg_lifted` persists (and Rule 1 still computes load); update changes it.

### Correction (supersedes the 0.1.10 caveat)
- The 0.1.10 note predicted setting WeightTraining fitness contribution to 100%
  would be a **no-op for the calendar tile / compliance ring**. **That was wrong.**
  Applied live (`update_activity_type` WeightTraining `ctlFactor/atlFactor = 1`,
  Yoga `= 0`) and the athlete confirmed: the gym session's calendar tile now shows
  `Load 41` (no brackets), and the Plan Builder weekly compliance ring now adds to
  the weekly total and %. Intervals auto-re-analysed historical sessions. So the
  Activity-Types fitness contribution **is** the lever for that display path.
  ADR-009/ADR-011 updated accordingly.

### Other (operational, this date)
- Ride HR-zone revision `[100,120,150,163,174,181,190]` applied and confirmed.
- IcuSync **demoted to secondary/backup** (not retired) while the custom MCP
  burns in — see ADR-012.

## 0.1.10 — 2026-06-02

Phase 8 — expose activity-type fitness-contribution config.

### Added
- **`update_activity_type`** — configure an activity type's CTL (Fitness) and ATL
  (Fatigue) contribution multipliers (`icu_type_settings`: `{type, ctlFactor,
  atlFactor}`, 1.0 = 100%). Preview-by-default safety guard (no write unless
  `confirm: true`); reads the full `icu_type_settings` array, merges the entry for
  the type, and writes it back via `PUT /athlete/{id}` (other types untouched).
  Verified live: preview returns the diff and writes nothing; missing-factor input
  is rejected.

### Investigation note (important)
- The activity-type config is `icu_type_settings` (athlete-level), **not** a sport
  setting or the (nonexistent) `athlete-types` endpoint the handover guessed. The
  only fields are `ctlFactor`/`atlFactor`.
- These multipliers scale how a type's `icu_training_load` feeds the **PMC**. They
  do **not** drive Intervals' HR/power-derived load shown on the **calendar day
  tile / Plan Builder compliance ring**. Evidence: WeightTraining gym load already
  feeds CTL/ATL at full weight (Phase 6), so its effective factor is already ~1,
  yet the ring still shows 0 — i.e. the ring uses a separate computed-load path.
  So setting WeightTraining to 100% is expected to be a no-op for the tile/ring.
  The tool is provided to expose the config as requested; the display discrepancy
  remains a Path A (HR strap) / Path C (accept) matter. Not auto-applied.

## 0.1.9 — 2026-06-02

Phase 7 — athlete sport-settings write tool.

### Added
- **`update_sport_settings`** — write FTP, indoor FTP, LTHR, max HR, resting HR,
  power zones, and HR zones for a sport. Behaviour:
  - **Preview-by-default safety guard:** without `confirm: true` it returns a diff
    (current → proposed) and writes nothing; `confirm: true` commits.
  - Only supplied fields are changed (partial merge); omitted fields untouched.
  - Zone arrays validated: 7 strictly-ascending values; HR zones' top must not
    exceed `max_hr` (supplied or existing).
  - Resolves the **actual** API shape (the handover's `PUT …/settings/{sport}`
    path does not exist): sport fields go to `PUT /sport-settings/{id}` (record
    located by its `types` list), and `resting_hr` is athlete-level
    (`icu_resting_hr` via `PUT /athlete/{id}`).
- New client methods: `listSportSettings`, `updateSportSettings`, `getAthlete`,
  `updateAthlete`.

### Verified (live)
- Preview returns the HR-zone diff and writes nothing (re-read confirmed unchanged).
- Non-ascending zone array is rejected.
- Benign `resting_hr` round-trip (64 → 65 → 64) committed and reverted; the PUT is
  a partial merge (athlete `name` and Ride `ftp`/`hr_zones` untouched).
- The recommended Ride HR-zone revision `[100,120,150,163,174,181,190]` was **not**
  applied — left for the athlete's confirmed call per the handover.

## 0.1.8 — 2026-06-02

CR-01 read side completed.

### Added
- **CR-01 (read side) — `get_events` note projection** now returns `color`,
  `end_date_local`, and `for_week` (previously only the `push_note`/`update_note`
  write side carried them; the read projection omitted them). Verified live: a
  week-row NOTE round-trips `color: #6b7280`, `for_week: true`, and the exclusive
  `end_date_local`. CR-01 is now complete end-to-end.

### Investigation — Phase 6 (WeightTraining load in PMC)
- Concluded **no code change required**. The Activity schema has no separate
  manual-load field/flag; `icu_training_load` is the sole load field, it persists
  across edits, and all 11 historical gym activities already carry it. A PMC
  reconstruction (daily load implied by the ATL recurrence) matches the activity
  sum **including** gym on pure-gym days — i.e. WeightTraining load is already
  feeding CTL/ATL. The "load not counting" premise was not reproduced. Details in
  the handover doc; awaiting the operator's UI confirmation before closing.

## 0.1.7 — 2026-06-02

Phase 5 enablement — clear-a-week support for `push_sport_targets`.

### Changed
- **`push_sport_targets` accepts an empty `sport_targets[]`** — meaning "clear the
  week": delete all of its TARGET events and recreate none. Resolves the open
  question in CR-06 (previously the schema enforced `.min(1)`). NOTE events in the
  week are never touched. Useful for travel / no-target weeks and for tidying
  stray placeholders. The non-empty behaviour (one TARGET per sport) is unchanged.

### Applied (live calendar, athlete i579914)
- **CR-04** — removed the null-load TARGET placeholder on the 2026-05-04 week.
- **CR-05** — relabelled the 2026-07-27 week as Base recovery (Ride 99/120 min,
  WeightTraining 66/90 min, Base-recovery notes).
- **CR-06** — cleared the Build TARGET events on the UK-trip weeks 2026-08-03 and
  2026-08-10; the week-row NOTE events (113843239, 113843254) were preserved.
- **CR-07** — verified Build progression (spot-checked 2026-08-17, 2026-09-07,
  2026-09-21, 2026-11-02 — loads and Phase 2/3 notes correct). No changes needed.

## 0.1.6 — 2026-06-02

Coaching-agent review follow-ups (BUG-03, BUG-04).

### Fixed
- **BUG-03 — Yoga/IMT activities mis-bucketed as rides.** `get_training_history`
  (and `get_training_summary`, which had the same flaw) split rides from gym by
  `type === "WeightTraining"`, so a Yoga/IMT activity fell into `rides` and
  contaminated Ride TSS/volume. Bucketing is now `rides = {Ride, VirtualRide}`
  and `gymSessions` = everything else (WeightTraining, Yoga, and any future
  ancillary type). New `RIDE_TYPES`/`isRide()` helper is the single source of
  truth for the split.

### Added
- **BUG-04 — per-sport compliance in `get_weekly_targets`.** Each entry in a
  week's `sport_targets[]` now carries its own `completed_load` and `compliance`
  (on_track/under/over/unknown), computed from completed activities of that sport
  within the week. A Ride target is credited with both `Ride` and `VirtualRide`
  activities; other sports match their exact type. Week-level
  `load_target`/`completed_load`/`compliance` are unchanged.

### Deploy
- Image bumped to `0.1.6`; `k8s/deployment.yaml` updated (drives the ArgoCD sync).
- No behavioural change to OAuth/transport — a reconnect is only needed if the
  pod was replaced and claude.ai holds a stale session id (per 0.1.3 note).

## 0.1.5 — 2026-06-02 (branch: feature/redis-oauth-store)

PR #1 review fixes (supersedes the 0.1.4 branch test image before merge).

### Fixed
- Redis store fails fast on outage (`enableOfflineQueue: false`, `maxRetriesPerRequest: 0`,
  bounded `connectTimeout`/`commandTimeout`) so a Redis outage degrades to
  cache-miss → re-auth instead of hanging — honouring the documented promise.

### Docs / housekeeping
- Documented the intentional refresh-token TTL (30-day rotating; was non-expiring in-memory).
- Corrected 0.1.4 release/deploy semantics and ADR-007 status/scope wording for `main`.
- Synced `package-lock.json` version metadata.
- New image tag `0.1.5` (the review fix changes runtime behaviour, so the tag is bumped).

## 0.1.4 — 2026-06-02 (branch: feature/redis-oauth-store)

### Added
- **Optional Redis-backed OAuth state** (`src/oauth-store.ts`). When `REDIS_URL`
  is set, OAuth codes/access/refresh tokens persist in Redis so they survive pod
  rollouts — claude.ai is no longer forced to re-authenticate after a deploy.
  Unset → in-memory (unchanged). Redis errors degrade gracefully to in-memory
  behaviour (reads miss → re-auth) rather than failing/crashing.
- `MinimalOAuthProvider` refactored to an injected async `OAuthStore`; generic
  and reusable as a template for the other MCP servers (see README).
- `ioredis` dependency.

### Verified
- Token persistence proven against the cluster Redis: a token issued by one
  server process validated successfully on a second fresh process (simulated
  rollout) — `HTTP 200`, tool call returned data. Test keys cleaned up.

### Deploy notes
- Image `0.1.4` is built and pushed. `REDIS_URL` has been added to the
  `intervals-mcp-secrets` Secret (sourced from `redis/redis-credentials`).
- Validated live: deployed from this branch and confirmed an OAuth token survives
  a real pod rollout (token issued, `rollout restart`, same token reused → 200).
- On merge to `main`, ArgoCD deploys `0.1.4` (the manifest image tag is bumped in
  this PR). After the first deploy that switches on Redis, reconnect the connector
  ONCE — the pre-existing token predates the Redis store; subsequent rollouts need
  no re-auth.
- The MCP session transport remains in-memory by design; only the OAuth layer is
  persisted.

## 0.1.3 — 2026-06-02

### Fixed
- **Trust proxy / rate limiter (BUG-01 contributor):** set Express `trust proxy: 1`.
  Behind the nginx ingress, `X-Forwarded-For` was set while `trust proxy` was
  false, so the MCP SDK's rate limiters on the OAuth routes threw
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` (seen in pod logs). Now resolved.

### Added
- **CR-01:** `push_note` accepts an optional `color` (hex string, e.g. `#33aa33`).
- **CR-02:** `update_note` — update an existing NOTE event in place (name,
  description, color, start/end dates, for_week, tags). NOTE events accept PUT
  (verified), so no delete-then-recreate is needed.

### Diagnostic note (BUG-01)
- The reported "Error occurred during tool execution on every tool" was **not**
  a server fault. The pod was healthy and a fresh end-to-end PKCE → token →
  initialize → tools/call session succeeded. Root cause: claude.ai held a stale
  `Mcp-Session-Id` from a pre-rollout pod; the new pod returns 404 "Unknown
  session", which claude.ai surfaces opaquely. **Resolution: reconnect the
  connector / start a new conversation after any deploy.** Sessions are in-memory
  per pod (single replica) by design.

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
