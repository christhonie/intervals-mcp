/**
 * Intervals.icu MCP server — tool definitions.
 *
 * Each tool wraps one or more Intervals.icu endpoints and folds in the
 * coaching-layer logic (Rule 1 load calc, structured readiness flags, week-row
 * note semantics, Plan Builder targets) so the calling agent gets a complete
 * result from a single call. See docs/ for requirements and the decision log.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient, IntervalsApiError } from "./intervals-client.js";
import type { IntervalsConfig } from "./config.js";
import { applyRule1, fitnessFlags, hrvTrendDown } from "./business.js";
import { addDays, daysAgo, daysFromNow, isMonday, toDateTime, today, weekStartMonday } from "./dates.js";
import * as schemas from "./schemas.js";

const VERSION = "0.1.6";

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
					type: e.type,
					description: e.description,
					icu_training_load: e.icu_training_load,
					moving_time: e.moving_time,
					indoor: e.indoor,
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
					"Update a planned workout event. Applies Rule 1 when rpe + duration_minutes are given without an explicit load; the type is inferred from the existing event if not supplied.",
				inputSchema: schemas.UpdateEventInput,
				annotations: WRITE_IDEM,
			},
			async (args) => {
				const body: Record<string, unknown> = {};
				for (const k of ["name", "description", "icu_training_load", "moving_time", "tags", "type"] as const) {
					if ((args as any)[k] !== undefined) body[k] = (args as any)[k];
				}
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
				for (const k of ["name", "description", "icu_rpe", "icu_training_load", "tags", "type"] as const) {
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
					"Set per-sport weekly targets for a week. Per-sport breakdown is modelled as separate TARGET events (one per sport), since the API has no nested sport-target field and rejects PUT on TARGET events. This REPLACES all existing TARGET events in the week (delete-then-recreate) with one TARGET per supplied sport, each carrying load_target, duration (time_target), optional distance, and notes (description). Per-sport loads should sum to the intended weekly total.",
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
	}
}
