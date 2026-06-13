/**
 * Intervals.icu MCP server — tool definitions.
 *
 * Each tool wraps one or more Intervals.icu endpoints and folds in the
 * coaching-layer logic (Rule 1 load calc, structured readiness flags, week-row
 * note semantics, Plan Builder targets) so the calling agent gets a complete
 * result from a single call. See docs/ for requirements and the decision log.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient, IntervalsApiError, normalizeActivityId } from "./intervals-client.js";
import type { IntervalsConfig } from "./config.js";
import { applyRule1, fitnessFlags, hrvTrendDown } from "./business.js";
import { addDays, daysAgo, daysFromNow, isMonday, toDateTime, today, weekStartMonday } from "./dates.js";
import * as schemas from "./schemas.js";

const VERSION = "0.1.14";

const INSTRUCTIONS = [
	"Intervals.icu MCP — live access to the athlete's training data and calendar.",
	"",
	"DATE ACCURACY: default date ranges are computed from the server clock (UTC).",
	"For anything date-sensitive, pass explicit ISO dates (YYYY-MM-DD). Verify the",
	"athlete's current date before scheduling.",
	"",
	"BUSINESS RULES baked into write tools:",
	"- Rule 1 (WeightTraining only): when rpe + duration_minutes are supplied without",
	"  an explicit icu_training_load, load is computed as round(rpe*minutes*0.15).",
	"  For Ride/VirtualRide etc. load is NEVER auto-computed (it would corrupt TSS).",
	"- Tags pass through unchanged.",
	"- Notes can render on the week row via for_week + an exclusive end_date_local.",
].join("\n");

// ── Helpers ──

function text(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toNum(v: unknown): number | null {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
	return null;
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);
const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

/** eFTP is carried per-sport in wellness.sportInfo[], not as a top-level field. */
function extractEftp(r: any): number | null {
	const si = r?.sportInfo;
	if (Array.isArray(si) && si.length) {
		const ride = si.find((s: any) => s?.type === "Ride") ?? si[0];
		return toNum(ride?.eftp);
	}
	return toNum(r?.eftp);
}

function pick<T extends Record<string, any>>(obj: T, keys: string[]): Record<string, any> {
	const out: Record<string, any> = {};
	for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
	return out;
}

function stripNull(obj: Record<string, any>): Record<string, any> {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(obj ?? {})) {
		if (v !== null && v !== undefined) out[k] = v;
	}
	return out;
}

/** Wellness record's date is stored in its `id` field (YYYY-MM-DD). */
function wellnessDate(r: any): string {
	return r?.id ?? r?.date ?? "";
}

/**
 * Strip a leading `#` from a hex colour. PLAN events require bare hex
 * (e.g. "4caf50", not "#4caf50"); other categories tolerate both. We always
 * send the bare form so a single convention applies everywhere.
 */
function stripHash(color: string): string {
	return color.trim().replace(/^#/, "");
}

const RO = { readOnlyHint: true, idempotentHint: true } as const;
const WRITE = { readOnlyHint: false, idempotentHint: false } as const;
const WRITE_IDEM = { readOnlyHint: false, idempotentHint: true } as const;

/**
 * Cycling activity types. Used to split `rides` from everything else
 * (`gymSessions`: WeightTraining, Yoga, and any future ancillary type). A
 * non-cycling activity (e.g. Yoga/IMT) must never land in `rides`, or it
 * contaminates Ride TSS/volume calculations (BUG-03).
 */
const RIDE_TYPES = new Set(["Ride", "VirtualRide"]);
const isRide = (type: unknown): boolean => RIDE_TYPES.has(String(type));

export class IntervalsMcpServer {
	public server: McpServer;
	private client: IntervalsClient;

	constructor(config: IntervalsConfig) {
		this.client = new IntervalsClient(config);
		this.server = new McpServer({ name: "intervals-mcp", version: VERSION }, { instructions: INSTRUCTIONS });
		this.registerPhase1();
		this.registerPhase2();
		this.registerPhase3();
		this.registerPhase9();
		this.registerPhase10();
	}

	// ── Phase 1 ──

	private registerPhase1(): void {
		this.server.registerTool(
			"get_fitness_metrics",
			{
				description:
					"Retrieve CTL, ATL, TSB, ramp rate and eFTP for a date range from wellness PMC data. Returns a per-date series plus a summary for the most recent date with overreachRisk/fatigueSpike flags.",
				inputSchema: schemas.GetFitnessMetricsInput,
				annotations: RO,
			},
			async (args) => {
				const oldest = args.oldest ?? daysAgo(42);
				const newest = args.newest ?? today();
				const records = (await this.client.listWellness({ oldest, newest })) ?? [];
				const series = records
					.map((r: any) => {
						const ctl = toNum(r.ctl);
						const atl = toNum(r.atl);
						const tsb = toNum(r.tsb) ?? (ctl !== null && atl !== null ? Math.round(ctl - atl) : null);
						return {
							date: wellnessDate(r),
							ctl: round1(ctl),
							atl: round1(atl),
							tsb,
							rampRate: round2(toNum(r.rampRate)),
							eftp: extractEftp(r),
						};
					})
					.sort((a, b) => a.date.localeCompare(b.date));
				const latest = series[series.length - 1];
				const summary = latest
					? { ...latest, ...fitnessFlags(latest.ctl, latest.atl, latest.tsb) }
					: null;
				return text({ summary, series });
			},
		);

		this.server.registerTool(
			"get_training_history",
			{
				description:
					"Recent completed activities with key metrics, split into rides and gymSessions, newest first. Filters out Strava stub activities (null moving_time).",
				inputSchema: schemas.GetTrainingHistoryInput,
				annotations: RO,
			},
			async (args) => {
				const days = args.days ?? 14;
				const acts = (await this.client.listActivities({ oldest: daysAgo(days), newest: today() })) ?? [];
				const fields = [
					"id",
					"name",
					"type",
					"start_date_local",
					"moving_time",
					"icu_training_load",
					"average_heartrate",
					"average_cadence",
					"icu_rpe",
					"icu_weighted_avg_watts",
					"kg_lifted",
					"description",
				];
				const mapped = acts
					.filter((a: any) => a.moving_time != null)
					.map((a: any) => pick(a, fields))
					.sort((a, b) => String(b.start_date_local).localeCompare(String(a.start_date_local)));
				return text({
					rides: mapped.filter((a) => isRide(a.type)),
					gymSessions: mapped.filter((a) => !isRide(a.type)),
				});
			},
		);

		this.server.registerTool(
			"get_activity_detail",
			{
				description: "Full detail for a single completed activity (non-null fields only).",
				inputSchema: schemas.GetActivityDetailInput,
				annotations: RO,
			},
			async (args) => {
				const a = await this.client.getActivity(args.activity_id);
				return text(stripNull(a));
			},
		);

		this.server.registerTool(
			"get_events",
			{
				description:
					"Read the planned training calendar for a date range. Defaults to category WORKOUT. Flags completed=true when an event is paired to a completed activity.",
				inputSchema: schemas.GetEventsInput,
				annotations: RO,
			},
			async (args) => {
				const oldest = args.oldest ?? daysAgo(7);
				const newest = args.newest ?? daysFromNow(28);
				const category = args.category ?? "WORKOUT";
				const events = (await this.client.listEvents({ oldest, newest, category })) ?? [];
				const mapped = events.map((e: any) => ({
					id: e.id,
					name: e.name,
					start_date_local: e.start_date_local,
					end_date_local: e.end_date_local ?? null,
					type: e.type,
					description: e.description,
					icu_training_load: e.icu_training_load,
					moving_time: e.moving_time,
					indoor: e.indoor,
					// Note-row presentation fields (meaningful for category NOTE):
					// for_week renders the note on the week row; color is the calendar
					// swatch; end_date_local (above) is the exclusive range end.
					for_week: e.for_week ?? null,
					color: e.color ?? null,
					paired_activity_id: e.paired_activity_id ?? null,
					tags: e.tags ?? null,
					completed: e.paired_activity_id != null,
				}));
				return text(mapped);
			},
		);

		this.server.registerTool(
			"get_wellness",
			{
				description:
					"Wellness data (HRV, sleep, resting HR, weight, mood, etc.) for a date range, with an hrvTrendDown flag (HRV declining 3+ consecutive days).",
				inputSchema: schemas.GetWellnessInput,
				annotations: RO,
			},
			async (args) => {
				const oldest = args.oldest ?? daysAgo(7);
				const newest = args.newest ?? today();
				const records = (await this.client.listWellness({ oldest, newest })) ?? [];
				const mapped = records.map((r: any) => ({
					date: wellnessDate(r),
					hrv: r.hrv ?? null,
					hrvSDNN: r.hrvSDNN ?? null,
					restingHR: r.restingHR ?? null,
					sleepSecs: r.sleepSecs ?? null,
					sleepScore: r.sleepScore ?? null,
					weight: r.weight ?? null,
					ctl: round1(toNum(r.ctl)),
					atl: round1(toNum(r.atl)),
					tsb: toNum(r.tsb) ?? (toNum(r.ctl) !== null && toNum(r.atl) !== null ? Math.round((toNum(r.ctl) as number) - (toNum(r.atl) as number)) : null),
					fatigue: r.fatigue ?? null,
					mood: r.mood ?? null,
					motivation: r.motivation ?? null,
					spO2: r.spO2 ?? null,
					steps: r.steps ?? null,
				}));
				return text({ hrvTrendDown: hrvTrendDown(mapped), records: mapped });
			},
		);

		this.server.registerTool(
			"push_workout",
			{
				description:
					"Write a planned workout to the calendar (category WORKOUT). Applies Rule 1 for WeightTraining. The indoor field is only set if explicitly provided.",
				inputSchema: schemas.PushWorkoutInput,
				annotations: WRITE,
			},
			async (args) => {
				const body: Record<string, unknown> = {
					category: "WORKOUT",
					start_date_local: toDateTime(args.date),
					name: args.name,
					type: args.type,
				};
				if (args.description !== undefined) body.description = args.description;
				if (args.moving_time !== undefined) body.moving_time = args.moving_time;
				if (args.icu_training_load !== undefined) body.icu_training_load = args.icu_training_load;
				if (args.tags !== undefined) body.tags = args.tags;
				if (args.indoor !== undefined) body.indoor = args.indoor;
				applyRule1(body, {
					type: args.type,
					rpe: args.rpe,
					duration_minutes: args.duration_minutes,
					icu_training_load: args.icu_training_load,
				});
				return text(await this.client.createEvent(body));
			},
		);

		this.server.registerTool(
			"update_event",
			{
				description:
					"Update a planned WORKOUT, NOTE or PLAN event in place (PUT). Applies Rule 1 when rpe + duration_minutes are given without an explicit load; the type is inferred from the existing event if not supplied. Accepts an optional color (hex, with or without #; a leading # is stripped — PLAN bars require bare hex) and optional start_date_local / end_date_local to move or resize an event (e.g. shorten a PLAN phase bar). Only supplied fields are changed. NOTE: TARGET events reject PUT (including date changes) — use push_weekly_target or push_sport_targets (delete-then-recreate) to change a TARGET.",
				inputSchema: schemas.UpdateEventInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				const body: Record<string, unknown> = {};
				for (const k of ["name", "description", "icu_training_load", "moving_time", "tags", "type"] as const) {
					if ((args as any)[k] !== undefined) body[k] = (args as any)[k];
				}
				// Colour: send bare hex (PLAN convention; valid on all categories).
				if (args.color !== undefined) body.color = stripHash(args.color);
				// Dates: full ISO datetime required on POST/PUT (toDateTime appends
				// midnight). PLAN/WORKOUT/NOTE accept date changes on PUT; TARGET
				// rejects them ("Cannot change TARGET date") — see push_weekly_target.
				if (args.start_date_local !== undefined) body.start_date_local = toDateTime(args.start_date_local);
				if (args.end_date_local !== undefined) body.end_date_local = toDateTime(args.end_date_local);
				if (args.rpe !== undefined && args.duration_minutes !== undefined && args.icu_training_load === undefined) {
					let type = args.type;
					if (!type) {
						const existing = await this.client.getEvent(args.event_id);
						type = existing?.type;
					}
					applyRule1(body, { type, rpe: args.rpe, duration_minutes: args.duration_minutes });
				}
				return text(await this.client.updateEvent(args.event_id, body));
			},
		);

		this.server.registerTool(
			"push_note",
			{
				description:
					"Write a calendar Note (category NOTE). Supports single-day notes and week-row range notes. For a weekly note set for_week=true and end_date_local = start + 7 days (exclusive). Never carries training load.",
				inputSchema: schemas.PushNoteInput,
				annotations: WRITE,
			},
			async (args) => {
				const body: Record<string, unknown> = {
					category: "NOTE",
					start_date_local: toDateTime(args.start_date_local),
					name: args.name,
				};
				if (args.description !== undefined) body.description = args.description;
				if (args.end_date_local !== undefined) body.end_date_local = toDateTime(args.end_date_local);
				if (args.for_week !== undefined) body.for_week = args.for_week;
				if (args.color !== undefined) body.color = args.color;
				if (args.tags !== undefined) body.tags = args.tags;
				return text(await this.client.createEvent(body));
			},
		);

		this.server.registerTool(
			"update_note",
			{
				description:
					"Update an existing calendar Note (category NOTE). NOTE events accept PUT, so this is a direct in-place update (unlike TARGET events). Provide event_id plus any of name, description, color, start_date_local, end_date_local, for_week, tags.",
				inputSchema: schemas.UpdateNoteInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				const body: Record<string, unknown> = { category: "NOTE" };
				if (args.name !== undefined) body.name = args.name;
				if (args.description !== undefined) body.description = args.description;
				if (args.color !== undefined) body.color = args.color;
				if (args.start_date_local !== undefined) body.start_date_local = toDateTime(args.start_date_local);
				if (args.end_date_local !== undefined) body.end_date_local = toDateTime(args.end_date_local);
				if (args.for_week !== undefined) body.for_week = args.for_week;
				if (args.tags !== undefined) body.tags = args.tags;
				return text(await this.client.updateEvent(args.event_id, body));
			},
		);

		this.server.registerTool(
			"get_power_curves",
			{
				description:
					"Best power efforts over standard durations for a sport type. NOTE: the athlete power-curves endpoint has required filter params whose semantics need live validation — treat output as provisional until verified.",
				inputSchema: schemas.GetPowerCurvesInput,
				annotations: RO,
			},
			async (args) => {
				const type = args.type ?? "Ride";
				const data = await this.client.listPowerCurves({
					type,
					oldest: args.oldest,
					newest: args.newest,
				});
				const STD = [
					{ duration: "5s", secs: 5 },
					{ duration: "1min", secs: 60 },
					{ duration: "5min", secs: 300 },
					{ duration: "20min", secs: 1200 },
					{ duration: "60min", secs: 3600 },
				];
				const curves = ((data?.list as any[]) ?? []).map((c: any) => {
					const secs: number[] = Array.isArray(c.secs) ? c.secs : [];
					const watts: number[] = Array.isArray(c.watts) ? c.watts : [];
					const wkg: number[] = Array.isArray(c.watts_per_kg) ? c.watts_per_kg : [];
					const points = STD.map((s) => {
						const idx = secs.indexOf(s.secs);
						return {
							duration: s.duration,
							secs: s.secs,
							watts: idx >= 0 ? (toNum(watts[idx]) ?? null) : null,
							watts_per_kg: idx >= 0 ? round2(toNum(wkg[idx])) : null,
						};
					});
					return {
						label: c.label,
						start_date_local: c.start_date_local,
						end_date_local: c.end_date_local,
						weight: c.weight,
						points,
					};
				});
				return text({ type, curves });
			},
		);

		this.server.registerTool(
			"get_training_summary",
			{
				description:
					"Aggregate training load and volume for a period: total/ride/gym hours and load, plus avg_ctl, max_atl, min_tsb from wellness.",
				inputSchema: schemas.GetTrainingSummaryInput,
				annotations: RO,
			},
			async (args) => {
				const oldest = args.oldest ?? daysAgo(28);
				const newest = args.newest ?? today();
				const [acts, wellness] = await Promise.all([
					this.client.listActivities({ oldest, newest }),
					this.client.listWellness({ oldest, newest }),
				]);
				const valid = (acts ?? []).filter((a: any) => a.moving_time != null);
				const hours = (list: any[]) => list.reduce((s, a) => s + (toNum(a.moving_time) ?? 0), 0) / 3600;
				const load = (list: any[]) => list.reduce((s, a) => s + (toNum(a.icu_training_load) ?? 0), 0);
				const rides = valid.filter((a: any) => isRide(a.type));
				const gym = valid.filter((a: any) => !isRide(a.type));
				const ctls = (wellness ?? []).map((r: any) => toNum(r.ctl)).filter((n): n is number => n !== null);
				const atls = (wellness ?? []).map((r: any) => toNum(r.atl)).filter((n): n is number => n !== null);
				const tsbs = (wellness ?? [])
					.map((r: any) => toNum(r.tsb) ?? (toNum(r.ctl) !== null && toNum(r.atl) !== null ? (toNum(r.ctl) as number) - (toNum(r.atl) as number) : null))
					.filter((n): n is number => n !== null);
				const round2 = (n: number) => Math.round(n * 100) / 100;
				return text({
					oldest,
					newest,
					total_hours: round2(hours(valid)),
					total_load: load(valid),
					ride_hours: round2(hours(rides)),
					gym_hours: round2(hours(gym)),
					avg_ctl: ctls.length ? round2(ctls.reduce((s, n) => s + n, 0) / ctls.length) : null,
					max_atl: atls.length ? Math.max(...atls) : null,
					min_tsb: tsbs.length ? Math.round(Math.min(...tsbs)) : null,
					ride_count: rides.length,
					gym_count: gym.length,
				});
			},
		);
	}

	// ── Phase 2 ──

	private registerPhase2(): void {
		this.server.registerTool(
			"update_activity",
			{
				description:
					"Update a completed activity (e.g. set training load and description after a gym check-in). Applies Rule 1 for WeightTraining when rpe + duration_minutes are given without an explicit load.",
				inputSchema: schemas.UpdateActivityInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				const body: Record<string, unknown> = {};
				for (const k of ["name", "description", "icu_rpe", "icu_training_load", "tags", "type", "kg_lifted"] as const) {
					if ((args as any)[k] !== undefined) body[k] = (args as any)[k];
				}
				applyRule1(body, {
					type: args.type,
					rpe: args.rpe,
					duration_minutes: args.duration_minutes,
					icu_training_load: args.icu_training_load,
				});
				return text(stripNull(await this.client.updateActivity(args.activity_id, body)));
			},
		);

		this.server.registerTool(
			"create_activity",
			{
				description:
					"Create a completed (manual) activity directly, bypassing the UI 'mark as done' step. Sets source=MANUAL and applies Rule 1 for WeightTraining. Link to a planned event via paired_event_id.",
				inputSchema: schemas.CreateActivityInput,
				annotations: WRITE,
			},
			async (args) => {
				const body: Record<string, unknown> = {
					name: args.name,
					type: args.type,
					start_date_local: args.start_date_local,
					source: "MANUAL",
				};
				if (args.moving_time !== undefined) body.moving_time = args.moving_time;
				if (args.description !== undefined) body.description = args.description;
				if (args.paired_event_id !== undefined) body.paired_event_id = args.paired_event_id;
				if (args.tags !== undefined) body.tags = args.tags;
				if (args.indoor !== undefined) body.indoor = args.indoor;
				if (args.kg_lifted !== undefined) body.kg_lifted = args.kg_lifted;
				applyRule1(body, { type: args.type, rpe: args.rpe, duration_minutes: args.duration_minutes });
				return text(await this.client.createManualActivity(body));
			},
		);
	}

	// ── Phase 3 — Plan Builder ──

	private registerPhase3(): void {
		this.server.registerTool(
			"get_weekly_targets",
			{
				description:
					"Read Plan Builder weekly load targets (category TARGET), grouped by week. Each week returns the aggregate load_target (sum across sports), a current_week flag, compliance (on_track/under/over/unknown) vs completed load, and a sport_targets array — one entry per sport TARGET event in the week with its load_target, duration_minutes, distance_m, notes, and its own completed_load + compliance for that sport (Ride targets are credited with both Ride and VirtualRide activities).",
				inputSchema: schemas.GetWeeklyTargetsInput,
				annotations: RO,
			},
			async (args) => {
				const oldest = args.oldest ?? daysAgo(28);
				const newest = args.newest ?? daysFromNow(84);
				const events = (await this.client.listEvents({ oldest, newest, category: "TARGET" })) ?? [];
				const todayStr = today();
				const currentWeekStart = weekStartMonday(todayStr);

				// Group TARGET events by ISO week (Monday). Per-sport targets are
				// separate TARGET events sharing a week (see decision log).
				const byWeek = new Map<string, any[]>();
				for (const e of events) {
					const ws = weekStartMonday(String(e.start_date_local).slice(0, 10));
					if (!byWeek.has(ws)) byWeek.set(ws, []);
					byWeek.get(ws)!.push(e);
				}

				// Completed load per week for started weeks (compliance), both as a
				// week total and split by activity type (for per-sport compliance).
				const startedWeeks = [...byWeek.keys()].filter((w) => w <= todayStr);
				const loadByWeek = new Map<string, number>();
				const loadByWeekType = new Map<string, Map<string, number>>();
				if (startedWeeks.length) {
					const minStart = startedWeeks.sort()[0];
					const acts = (await this.client.listActivities({ oldest: minStart, newest: todayStr })) ?? [];
					for (const a of acts) {
						if (a.moving_time == null) continue;
						const ws = weekStartMonday(String(a.start_date_local).slice(0, 10));
						const l = toNum(a.icu_training_load) ?? 0;
						loadByWeek.set(ws, (loadByWeek.get(ws) ?? 0) + l);
						if (!loadByWeekType.has(ws)) loadByWeekType.set(ws, new Map());
						const m = loadByWeekType.get(ws)!;
						m.set(String(a.type), (m.get(String(a.type)) ?? 0) + l);
					}
				}

				// Completed load for a sport target's type within a week. A Ride target
				// is credited with all cycling-type activities (Ride + VirtualRide);
				// other sports match their exact type.
				const completedForType = (ws: string, type: unknown): number => {
					const m = loadByWeekType.get(ws);
					if (!m) return 0;
					if (isRide(type)) {
						let s = 0;
						for (const rt of RIDE_TYPES) s += m.get(rt) ?? 0;
						return s;
					}
					return m.get(String(type)) ?? 0;
				};

				const classify = (done: number, target: number): string => {
					if (target <= 0) return "unknown";
					const ratio = done / target;
					if (ratio < 0.9) return "under";
					if (ratio > 1.1) return "over";
					return "on_track";
				};
				// Names that are sport types are not phase labels.
				const SPORT_TYPES = new Set([
					"Ride", "VirtualRide", "Run", "Swim", "WeightTraining", "Yoga",
				]);

				const result = [...byWeek.entries()]
					.map(([week_start, evs]) => {
						const started = week_start <= todayStr;
						const sport_targets = evs
							.map((e: any) => {
								const lt = toNum(e.load_target);
								const sportCompleted = started ? Math.round(completedForType(week_start, e.type)) : null;
								return {
									type: e.type ?? null,
									load_target: lt,
									duration_minutes:
										toNum(e.time_target) !== null ? Math.round((toNum(e.time_target) as number) / 60) : null,
									distance_m: toNum(e.distance_target),
									notes: e.description ?? null,
									completed_load: sportCompleted,
									compliance:
										started && lt !== null && lt > 0 ? classify(sportCompleted ?? 0, lt) : "unknown",
								};
							})
							.sort((a, b) => String(a.type).localeCompare(String(b.type)));
						const loadSum = sport_targets.reduce((s, t) => s + (t.load_target ?? 0), 0);
						const load_target = loadSum > 0 ? loadSum : null;
						// Preserve a phase label if an event name is not itself a sport type.
						const phaseEvent = evs.find((e: any) => e.name && !SPORT_TYPES.has(e.name));
						const phase_name = phaseEvent?.name ?? null;
						const completed_load = started ? Math.round(loadByWeek.get(week_start) ?? 0) : null;
						const compliance =
							started && load_target !== null ? classify(completed_load ?? 0, load_target) : "unknown";
						return {
							week_start,
							load_target,
							phase_name,
							current_week: week_start === currentWeekStart,
							completed_load,
							compliance,
							sport_targets,
						};
					})
					.sort((a, b) => a.week_start.localeCompare(b.week_start));
				return text(result);
			},
		);

		this.server.registerTool(
			"push_weekly_target",
			{
				description:
					"Write or update a single weekly load target (category TARGET). start/end dates span the week (end exclusive). Never sets icu_training_load or moving_time. " +
					"Provide event_id to replace an existing Plan Builder target: the Intervals.icu API rejects PUT on TARGET events (HTTP 422 'Cannot change TARGET date'), so an update is done by delete-then-recreate (the recreated event gets a new id).",
				inputSchema: schemas.PushWeeklyTargetInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				const body: Record<string, unknown> = {
					category: "TARGET",
					// The API rejects TARGET creation without a type
					// (HTTP 422 "type is required for category TARGET").
					// Plan Builder weekly targets use type "Ride".
					type: "Ride",
					start_date_local: toDateTime(args.week_start),
					end_date_local: toDateTime(addDays(args.week_start, 7)),
					load_target: args.load_target,
				};
				if (args.phase_name !== undefined) body.name = args.phase_name;
				if (args.hours_target !== undefined) body.time_target = Math.round(args.hours_target * 3600);

				if (args.event_id === undefined) {
					return text(await this.client.createEvent(body));
				}

				// TARGET events reject PUT, so replace via delete-then-recreate.
				// Tolerate 404 (already deleted) so the operation is idempotent.
				try {
					await this.client.deleteEvent(args.event_id);
				} catch (e) {
					if (!(e instanceof IntervalsApiError && e.status === 404)) throw e;
				}
				const created = await this.client.createEvent(body);
				return text({ replaced: true, deleted_event_id: args.event_id, created });
			},
		);

		this.server.registerTool(
			"push_sport_targets",
			{
				description:
					"Set per-sport weekly targets for a week. Per-sport breakdown is modelled as separate TARGET events (one per sport), since the API has no nested sport-target field and rejects PUT on TARGET events. This REPLACES all existing TARGET events in the week (delete-then-recreate) with one TARGET per supplied sport, each carrying load_target, duration (time_target), optional distance, and notes (description). Per-sport loads should sum to the intended weekly total. Pass an empty sport_targets array to CLEAR the week (delete all its TARGET events, recreate none) — useful for travel / no-target weeks. NOTE events are never touched.",
				inputSchema: schemas.PushSportTargetsInput,
				annotations: WRITE,
			},
			async (args) => {
				const ws = args.week_start;
				const weekKey = weekStartMonday(ws);
				// Remove existing TARGET events in this week.
				const existing = (await this.client.listEvents({ oldest: ws, newest: addDays(ws, 6), category: "TARGET" })) ?? [];
				const inWeek = existing.filter(
					(e: any) => weekStartMonday(String(e.start_date_local).slice(0, 10)) === weekKey,
				);
				const deleted: number[] = [];
				for (const e of inWeek) {
					try {
						await this.client.deleteEvent(e.id);
						deleted.push(e.id);
					} catch (err) {
						if (!(err instanceof IntervalsApiError && err.status === 404)) throw err;
					}
				}
				// Create one TARGET event per sport.
				const created: any[] = [];
				for (const st of args.sport_targets) {
					const body: Record<string, unknown> = {
						category: "TARGET",
						type: st.type,
						name: st.type,
						start_date_local: toDateTime(ws),
						end_date_local: toDateTime(addDays(ws, 7)),
					};
					if (st.load_target !== undefined) body.load_target = st.load_target;
					if (st.duration_minutes !== undefined) body.time_target = Math.round(st.duration_minutes * 60);
					if (st.distance_m !== undefined) body.distance_target = st.distance_m;
					if (st.notes !== undefined) body.description = st.notes;
					const c = await this.client.createEvent(body);
					created.push({ id: c.id, type: c.type, load_target: c.load_target });
				}
				return text({ week_start: ws, deleted, created_count: created.length, created });
			},
		);

		this.server.registerTool(
			"list_plan_folders",
			{
				description:
					"List workout-plan library folders (id, name, type) so a folder_id can be supplied to apply_plan.",
				inputSchema: schemas.ListPlanFoldersInput,
				annotations: RO,
			},
			async () => {
				const folders = (await this.client.listFolders()) ?? [];
				return text(folders.map((f: any) => pick(f, ["id", "name", "type", "description", "num_workouts"])));
			},
		);

		this.server.registerTool(
			"apply_plan",
			{
				description:
					"Apply a saved workout-plan folder to the calendar at a start date, placing all its workouts. The start date must be a Monday (week boundary).",
				inputSchema: schemas.ApplyPlanInput,
				annotations: WRITE,
			},
			async (args) => {
				const datePart = args.start_date_local.slice(0, 10);
				if (!isMonday(datePart)) {
					throw new Error(`start_date_local must be a Monday (week boundary); got ${datePart}`);
				}
				const start = args.start_date_local.length > 10 ? args.start_date_local : `${datePart}T00:00:00`;
				return text(await this.client.applyPlan({ folder_id: args.folder_id, start_date_local: start }));
			},
		);

		this.server.registerTool(
			"update_sport_settings",
			{
				description:
					"Write athlete sport settings (FTP, indoor FTP, LTHR, max HR, resting HR, power zones, HR zones). " +
					"SAFETY: this changes the foundational parameters behind every zone/TSS/Pw:HR calculation, so it is preview-by-default — " +
					"without confirm:true it returns a diff (current → proposed) and writes NOTHING. Pass confirm:true to commit. " +
					"Only the fields you supply are changed; omitted fields are left untouched. Zone arrays must be 7 strictly-ascending values " +
					"in the same format/order as the record's existing array (HR zones' last value must not exceed max_hr). resting_hr is athlete-level.",
				inputSchema: schemas.UpdateSportSettingsInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				// Locate the sport-settings record whose type list includes the sport.
				const all = (await this.client.listSportSettings()) ?? [];
				const rec = all.find((s: any) => Array.isArray(s.types) && s.types.includes(args.sport));
				if (!rec) {
					const known = all.flatMap((s: any) => s.types ?? []);
					throw new Error(`No sport-settings record matches sport "${args.sport}". Known sports: ${known.join(", ")}`);
				}

				// Validate zone arrays: strictly ascending; HR top ≤ effective max_hr.
				const ensureAscending = (label: string, arr?: number[]) => {
					if (!arr) return;
					for (let i = 1; i < arr.length; i++) {
						if (arr[i] <= arr[i - 1]) {
							throw new Error(`${label} must be strictly ascending; got [${arr.join(", ")}]`);
						}
					}
				};
				ensureAscending("power_zones", args.power_zones);
				ensureAscending("hr_zones", args.hr_zones);
				if (args.hr_zones) {
					const effectiveMaxHr = args.max_hr ?? rec.max_hr;
					const top = args.hr_zones[args.hr_zones.length - 1];
					if (effectiveMaxHr != null && top > effectiveMaxHr) {
						throw new Error(`hr_zones top (${top}) exceeds max_hr (${effectiveMaxHr})`);
					}
				}

				// Build the sport-level diff (only supplied fields).
				const sportFields = ["ftp", "indoor_ftp", "lthr", "max_hr", "power_zones", "hr_zones"] as const;
				const diff: Record<string, { current: unknown; proposed: unknown }> = {};
				const sportBody: Record<string, unknown> = {};
				for (const f of sportFields) {
					const proposed = (args as any)[f];
					if (proposed === undefined) continue;
					sportBody[f] = proposed;
					diff[f] = { current: rec[f] ?? null, proposed };
				}

				// resting_hr is athlete-level (icu_resting_hr), not on the sport record.
				let athleteCurrentResting: number | null = null;
				if (args.resting_hr !== undefined) {
					const athlete = await this.client.getAthlete();
					athleteCurrentResting = athlete?.icu_resting_hr ?? null;
					diff.resting_hr = { current: athleteCurrentResting, proposed: args.resting_hr };
				}

				if (Object.keys(diff).length === 0) {
					throw new Error("No settings fields supplied to update.");
				}

				// Preview-by-default: write nothing unless confirm:true.
				if (args.confirm !== true) {
					return text({
						preview: true,
						note: "No changes written. Re-call with confirm:true to commit.",
						sport: args.sport,
						sport_settings_id: rec.id,
						diff,
					});
				}

				// Commit. Sport-level fields first, then athlete-level resting_hr.
				const result: Record<string, unknown> = { confirmed: true, sport: args.sport, sport_settings_id: rec.id, changed: Object.keys(diff) };
				if (Object.keys(sportBody).length) {
					const updated = await this.client.updateSportSettings(rec.id, sportBody);
					result.sport_settings = pick(updated ?? {}, ["id", "types", ...sportFields]);
				}
				if (args.resting_hr !== undefined) {
					const updatedAthlete = await this.client.updateAthlete({ icu_resting_hr: args.resting_hr });
					result.icu_resting_hr = updatedAthlete?.icu_resting_hr ?? args.resting_hr;
				}
				return text(result);
			},
		);

		this.server.registerTool(
			"update_activity_type",
			{
				description:
					"Configure an activity type's fitness contribution — its CTL (Fitness) and ATL (Fatigue) multipliers in the athlete's " +
					"Activity Types settings (icu_type_settings). 1.0 = 100% contribution, 0 = excluded. " +
					"SAFETY: preview-by-default — without confirm:true it returns a diff (current → proposed) and writes NOTHING; pass confirm:true to commit. " +
					"The whole icu_type_settings array is read, the entry for `type` merged, and written back via the athlete record (other types untouched). " +
					"NOTE: these factors scale how the type's icu_training_load feeds the PMC; they do NOT change Intervals' HR/power-derived load shown on the calendar day tile.",
				inputSchema: schemas.UpdateActivityTypeInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				if (args.ctl_factor === undefined && args.atl_factor === undefined) {
					throw new Error("Provide at least one of ctl_factor / atl_factor.");
				}
				const athlete = await this.client.getAthlete();
				const current: any[] = Array.isArray(athlete?.icu_type_settings) ? athlete.icu_type_settings : [];
				const existing = current.find((e: any) => e.type === args.type);

				const ctlFactor = args.ctl_factor ?? existing?.ctlFactor;
				const atlFactor = args.atl_factor ?? existing?.atlFactor;
				if (ctlFactor === undefined || atlFactor === undefined) {
					throw new Error(
						`No existing override for "${args.type}" to inherit from — provide both ctl_factor and atl_factor.`,
					);
				}
				const proposedEntry = { type: args.type, ctlFactor, atlFactor };

				const diff = {
					[args.type]: {
						current: existing ?? "default (no override)",
						proposed: proposedEntry,
					},
				};

				if (args.confirm !== true) {
					return text({
						preview: true,
						note: "No changes written. Re-call with confirm:true to commit.",
						diff,
					});
				}

				// Merge into the full array (replace the entry for this type, else append).
				const merged = current.filter((e: any) => e.type !== args.type);
				merged.push(proposedEntry);
				const updated = await this.client.updateAthlete({ icu_type_settings: merged });
				const written = (updated?.icu_type_settings ?? merged).find((e: any) => e.type === args.type);
				return text({ confirmed: true, type: args.type, written, icu_type_settings: updated?.icu_type_settings ?? merged });
			},
		);
	}

	// ── Phase 9 — PLAN phase bars ──

	private registerPhase9(): void {
		this.server.registerTool(
			"push_plan_block",
			{
				description:
					"Create a PLAN event — a coloured phase bar that spans the Intervals.icu Plan page above the weekly TARGET rows (e.g. \"Phase 3 — Strength focus\"). The Plan Builder generates these internally; this tool creates them directly. start_date/end_date span the bar (end exclusive: the day AFTER the last visible day). color is bare hex (a leading # is stripped). type is required by the API but cosmetic for PLAN events (default Ride). No training load, no Rule 1, no for_week. Low-risk: PLAN events are freely editable/deletable afterwards.",
				inputSchema: schemas.PushPlanBlockInput,
				annotations: WRITE,
			},
			async (args) => {
				const body: Record<string, unknown> = {
					category: "PLAN",
					// The API rejects PLAN/TARGET creation without a type (HTTP 422).
					// The value is cosmetic for PLAN events.
					type: args.type ?? "Ride",
					name: args.name,
					start_date_local: toDateTime(args.start_date),
					end_date_local: toDateTime(args.end_date),
					// PLAN bars require bare hex (no #). Default green.
					color: stripHash(args.color ?? "4caf50"),
				};
				if (args.description !== undefined) body.description = args.description;
				if (args.tags !== undefined) body.tags = args.tags;
				return text(await this.client.createEvent(body));
			},
		);
	}

	// ── Phase 10 — raw activity streams ──

	private registerPhase10(): void {
		this.server.registerTool(
			"get_activity_streams",
			{
				description:
					"Raw per-second time-series (streams) for one completed activity — e.g. smo2, heartrate, watts, cadence, dfa_a1, RMSSD. Returns each requested stream as a sample array at 1 Hz; arrays are positionally aligned (index 0 = second 0; the same index across streams is the same moment). Use this for sub-interval analysis (e.g. standing-bout SmO₂ resaturation, intra-session drift) that the aggregate/detail tools cannot resolve. Stream names are case-sensitive and passed through unchanged (RMSSD is uppercase). Any requested stream the activity does not have is listed under missing_streams. Read-only.",
				inputSchema: schemas.GetActivityStreamsInput,
				annotations: RO,
			},
			async (args) => {
				// The API returns an array of { type, data, … } ActivityStream
				// objects. Key by stream name, preserving the caller's requested
				// names and their case, so the output matches what was asked for.
				const raw = (await this.client.getActivityStreams(args.activity_id, args.streams)) ?? [];
				const byType = new Map<string, any>();
				for (const s of raw) if (s && s.type != null) byType.set(String(s.type), s);

				const streams: Record<string, unknown> = {};
				const missing: string[] = [];
				let duration = 0;
				for (const name of args.streams) {
					const s = byType.get(name);
					const data = s && Array.isArray(s.data) ? s.data : null;
					if (data === null) {
						missing.push(name);
						continue;
					}
					streams[name] = data;
					if (data.length > duration) duration = data.length;
				}

				const result: Record<string, unknown> = {
					activity_id: normalizeActivityId(args.activity_id),
					duration_seconds: duration,
					sample_rate_hz: 1,
					streams,
				};
				if (missing.length) result.missing_streams = missing;
				return text(result);
			},
		);
	}
}
