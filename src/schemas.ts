/**
 * Zod input schemas (raw shapes) for each MCP tool. The MCP SDK's registerTool
 * expects a ZodRawShape (a plain object of zod types), not a z.object().
 */

import { z } from "zod";

// Anchored: a bare date (YYYY-MM-DD) or a full ISO datetime (YYYY-MM-DDTHH:MM:SS)
// — the two forms toDateTime emits. Anchoring rejects junk suffixes such as
// "2026-06-09foo" or "2026-06-09 10:00" that would otherwise reach the API as a
// confusing 422.
const isoDate = () =>
	z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/, "Expected ISO date YYYY-MM-DD or datetime YYYY-MM-DDTHH:MM:SS");

export const GetFitnessMetricsInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Default: 42 days ago."),
	newest: isoDate().optional().describe("End date (ISO). Default: today."),
};

export const GetTrainingHistoryInput = {
	days: z.number().int().positive().optional().describe("Number of days back to include. Default: 14."),
};

export const GetActivityDetailInput = {
	activity_id: z.string().describe("Activity id, e.g. i150320999 (i-prefix is normalised automatically)."),
};

export const GetActivityStreamsInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660 (i-prefix is normalised automatically)."),
	streams: z
		.array(z.string())
		.nonempty()
		.describe(
			'Stream names to fetch, e.g. ["smo2", "heartrate", "watts", "dfa_a1", "RMSSD"]. Passed to the API exactly as supplied — case-sensitive (e.g. RMSSD is uppercase in the stream registry). Known streams on a typical ride: time, watts, cadence, heartrate, distance, velocity_smooth, temp, torque, smo2, dfa_a1, RMSSD.',
		),
};

export const GetEventsInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Default: 7 days ago."),
	newest: isoDate().optional().describe("End date (ISO). Default: 28 days from today."),
	category: z.string().optional().describe("Event category filter. Default: WORKOUT."),
};

export const GetWellnessInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Default: 7 days ago."),
	newest: isoDate().optional().describe("End date (ISO). Default: today."),
};

export const PushWorkoutInput = {
	date: isoDate().describe("Calendar date for the planned workout (ISO)."),
	name: z.string().describe("Workout name shown on the calendar."),
	description: z.string().optional().describe("Workout description / structure."),
	type: z.string().describe("Activity type, e.g. Ride, VirtualRide, WeightTraining."),
	moving_time: z.number().int().optional().describe("Planned duration in seconds."),
	icu_training_load: z.number().int().optional().describe("Explicit training load (TSS). Optional."),
	tags: z.array(z.string()).optional().describe("Tag strings, passed through unchanged."),
	indoor: z.boolean().optional().describe("Pass through only if explicitly set."),
	rpe: z.number().optional().describe("RPE — used with duration_minutes for WeightTraining load (Rule 1)."),
	duration_minutes: z.number().optional().describe("Duration in minutes — used for WeightTraining load (Rule 1)."),
};

export const UpdateEventInput = {
	event_id: z.number().int().describe("Event id to update."),
	name: z.string().optional(),
	description: z.string().optional(),
	icu_training_load: z.number().int().optional(),
	moving_time: z.number().int().optional(),
	tags: z.array(z.string()).optional(),
	type: z.string().optional(),
	color: z
		.string()
		.optional()
		.describe("Event colour as hex, with or without a leading # (e.g. D85A30 or #D85A30). A leading # is stripped (PLAN events require bare hex). Valid on all event categories. Omitted = colour left unchanged."),
	start_date_local: isoDate()
		.optional()
		.describe("New start date (ISO). Accepted for WORKOUT/NOTE/PLAN events; TARGET events reject date changes on PUT (use push_weekly_target / push_sport_targets)."),
	end_date_local: isoDate()
		.optional()
		.describe("New exclusive end date (ISO) — the day AFTER the last visible day (e.g. shortening a PLAN phase bar). Accepted for WORKOUT/NOTE/PLAN; TARGET events reject date changes on PUT."),
	rpe: z.number().optional().describe("RPE — used with duration_minutes for WeightTraining load (Rule 1)."),
	duration_minutes: z.number().optional(),
};

export const PushNoteInput = {
	start_date_local: isoDate().describe("First day of the note (ISO)."),
	name: z.string().describe("Short label shown on the calendar."),
	description: z.string().optional().describe("Full note body, revealed on click."),
	end_date_local: isoDate()
		.optional()
		.describe("Exclusive end boundary: the day AFTER the last visible day. Omit for a single-day note."),
	for_week: z
		.boolean()
		.optional()
		.describe("When true, renders as a week-row text block (preferred for weekly notes)."),
	color: z.string().optional().describe("Optional hex colour for the note, e.g. #33aa33."),
	tags: z.array(z.string()).optional(),
};

export const UpdateNoteInput = {
	event_id: z.number().int().describe("Id of the NOTE event to update."),
	name: z.string().optional(),
	description: z.string().optional(),
	color: z.string().optional().describe("Hex colour, e.g. #33aa33."),
	start_date_local: isoDate().optional().describe("New first day of the note (ISO)."),
	end_date_local: isoDate().optional().describe("New exclusive end boundary (day after the last visible day)."),
	for_week: z.boolean().optional().describe("Week-row rendering toggle."),
	tags: z.array(z.string()).optional(),
};

export const GetPowerCurvesInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Optional."),
	newest: isoDate().optional().describe("End date (ISO). Optional."),
	type: z.string().optional().describe("Sport type for the curve. Default: Ride."),
};

export const GetTrainingSummaryInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Default: 28 days ago."),
	newest: isoDate().optional().describe("End date (ISO). Default: today."),
};

export const UpdateActivityInput = {
	activity_id: z.string().describe("Activity id, e.g. i150320999."),
	name: z.string().optional(),
	description: z.string().optional(),
	icu_rpe: z.number().optional(),
	icu_training_load: z.number().int().optional(),
	tags: z.array(z.string()).optional(),
	type: z.string().optional(),
	kg_lifted: z.number().optional().describe("Total weight lifted (kg) for a strength session — Intervals' Weight Lifted field."),
	rpe: z.number().optional().describe("RPE — used with duration_minutes for WeightTraining load (Rule 1)."),
	duration_minutes: z.number().optional(),
};

export const CreateActivityInput = {
	name: z.string(),
	type: z.string().describe("Activity type, e.g. WeightTraining, Ride."),
	start_date_local: z.string().describe("Start datetime (ISO, e.g. 2026-06-05T18:00:00)."),
	moving_time: z.number().int().optional().describe("Duration in seconds."),
	description: z.string().optional(),
	rpe: z.number().optional(),
	duration_minutes: z.number().optional(),
	paired_event_id: z.number().int().optional().describe("Link to a planned event."),
	tags: z.array(z.string()).optional(),
	indoor: z.boolean().optional(),
	kg_lifted: z.number().optional().describe("Total weight lifted (kg) for a strength session — Intervals' Weight Lifted field."),
};

export const GetWeeklyTargetsInput = {
	oldest: isoDate().optional().describe("Start date (ISO). Default: 4 weeks ago."),
	newest: isoDate().optional().describe("End date (ISO). Default: 12 weeks from today."),
};

export const PushWeeklyTargetInput = {
	week_start: isoDate().describe("Monday of the target week (ISO)."),
	load_target: z.number().int().describe("Target training load (TSS) for the week."),
	hours_target: z.number().optional().describe("Optional target hours."),
	phase_name: z.string().optional().describe("Optional phase label."),
	event_id: z
		.number()
		.int()
		.optional()
		.describe(
			"Existing TARGET event id to replace; omit to create a new target. Replacement is delete-then-recreate (TARGET events reject PUT), so the result carries a new event id.",
		),
};

export const PushSportTargetsInput = {
	week_start: isoDate().describe("Monday of the target week (ISO)."),
	sport_targets: z
		.array(
			z.object({
				type: z.string().describe("Sport type, e.g. Ride, WeightTraining, Yoga."),
				load_target: z.number().int().optional().describe("Target training load (TSS) for this sport."),
				duration_minutes: z.number().optional().describe("Target duration in minutes for this sport."),
				distance_m: z.number().optional().describe("Target distance in metres (omit for indoor sports)."),
				notes: z.string().optional().describe("Free-text coaching note for this sport (stored as the event description)."),
			}),
		)
		.describe(
			"One entry per sport. Each becomes a separate TARGET event in the week. All existing TARGET events in the week are replaced. Pass an empty array to CLEAR the week — delete all of its TARGET events and recreate none (e.g. travel / no-target weeks). NOTE events in the week are never touched.",
		),
};

export const ApplyPlanInput = {
	folder_id: z.number().int().describe("Plan-library folder id (see list_plan_folders)."),
	start_date_local: z.string().describe("Start date (ISO). Must be a Monday."),
};

export const ListPlanFoldersInput = {};

const zoneArray = (unit: string) =>
	z
		.array(z.number().int().positive())
		.length(7)
		.describe(`Seven ascending zone-boundary values in ${unit}. Same format/order as the existing array on the record.`);

export const UpdateSportSettingsInput = {
	sport: z
		.string()
		.describe("Sport whose settings to update, e.g. Ride, Run, Swim. Matched against each settings record's type list."),
	ftp: z.number().int().positive().optional().describe("Functional threshold power (watts)."),
	indoor_ftp: z.number().int().positive().optional().describe("Separate indoor FTP (watts), if applicable."),
	lthr: z.number().int().positive().optional().describe("Lactate threshold heart rate (bpm)."),
	max_hr: z.number().int().positive().optional().describe("Maximum heart rate (bpm)."),
	resting_hr: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Resting heart rate (bpm). Athlete-level (icu_resting_hr), written to the athlete record, not the sport settings."),
	power_zones: zoneArray("watts").optional(),
	hr_zones: zoneArray("bpm").optional(),
	confirm: z
		.boolean()
		.optional()
		.describe(
			"Safety guard. When false/omitted the tool returns a preview diff (current → proposed) WITHOUT writing. Pass true to commit the change.",
		),
};

const factor = () =>
	z
		.number()
		.min(0)
		.max(1)
		.describe("Contribution multiplier 0–1 (1.0 = 100%). Stored in the athlete's icu_type_settings.");

export const PushPlanBlockInput = {
	name: z.string().describe('Phase label shown on the Plan Builder bar, e.g. "Phase 3 — Strength focus".'),
	start_date: isoDate().describe("First day of the phase (ISO)."),
	end_date: isoDate().describe("Exclusive end boundary: the day AFTER the last visible day of the phase."),
	description: z.string().optional().describe("Short one-line summary shown when the bar is clicked."),
	color: z
		.string()
		.optional()
		.describe("Bar colour as hex, with or without a leading # (e.g. D85A30 or #D85A30). A leading # is stripped. Default 4caf50 (green)."),
	type: z
		.string()
		.optional()
		.describe("Activity type. Required by the API for PLAN events but cosmetic. Default Ride."),
	tags: z.array(z.string()).optional(),
};

export const UpdateActivityTypeInput = {
	type: z
		.string()
		.describe("Activity type to configure, e.g. WeightTraining, Yoga, Ride. Matches Intervals' Settings → Activity Types row."),
	ctl_factor: factor()
		.optional()
		.describe("Fitness (CTL) contribution multiplier 0–1 (1.0 = 100%)."),
	atl_factor: factor()
		.optional()
		.describe("Fatigue (ATL) contribution multiplier 0–1 (1.0 = 100%)."),
	confirm: z
		.boolean()
		.optional()
		.describe(
			"Safety guard. When false/omitted the tool returns a preview diff (current → proposed) WITHOUT writing. Pass true to commit.",
		),
};
