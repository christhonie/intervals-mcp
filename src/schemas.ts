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

// ── Phase 11 — Signal Processing Toolkit (reducers) ──

// A stream reference is either a raw stream name or a derived-stream handle.
const streamRef = (role = "Stream") =>
	z
		.string()
		.describe(
			`${role} reference: a raw stream name (e.g. smo2, heartrate, RMSSD — case-sensitive) or a derived-stream handle of the form source~op:params (e.g. smo2~mean:10 for a 10s trailing mean, or smo2~mean:10~d:1 for its first derivative).`,
		);
const startSec = () => z.number().int().nonnegative().optional().describe("Window start offset in seconds from activity start. Default: 0.");
const endSec = () => z.number().int().nonnegative().optional().describe("Window end offset in seconds (exclusive). Default: full stream length.");
const smoothWindow = () =>
	z
		.number()
		.int()
		.positive()
		.optional()
		.describe("If set, apply a trailing rolling mean of this many seconds before processing (suppresses noise). Equivalent to passing a ~mean:N handle.");
const includeStream = () =>
	z
		.boolean()
		.optional()
		.describe(
			"If true, also return intermediate_stream — the exact transformed (smoothed/derived) values the detector ran on, aligned to the window (index 0 = start_sec). Lets you inspect the signal (e.g. the trailing-mean phase lag) directly. Default false. (Equivalent to calling extract_segment on the resolved_handle.)",
		);

export const DetectThresholdCrossingsInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream: streamRef(),
	threshold: z.number().describe("The crossing value."),
	direction: z.enum(["rising", "falling", "both"]).describe("Which crossings to report."),
	smooth_window_seconds: smoothWindow(),
	min_duration_seconds: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Minimum time the stream must stay on the far side of the threshold for a crossing to count. Suppresses brief excursions. Default: 0 (report all)."),
	start_sec: startSec(),
	end_sec: endSec(),
	include_stream: includeStream(),
};

export const DetectPeaksNadirsInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream: streamRef(),
	type: z.enum(["peaks", "nadirs", "both"]).describe("Detect local maxima, minima, or both."),
	min_prominence: z
		.number()
		.positive()
		.describe("Minimum prominence (value difference from the surrounding baseline) to qualify. Suppresses noise — e.g. SmO₂ ~5%, HR ~5 bpm."),
	min_separation_seconds: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Minimum gap between consecutive same-type events; the more prominent wins. Default: 30."),
	smooth_window_seconds: smoothWindow(),
	start_sec: startSec(),
	end_sec: endSec(),
	include_stream: includeStream(),
};

export const ComputeEpochStatsInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	streams: z.array(streamRef()).nonempty().describe("One or more stream references; the same epoch grid is applied to all."),
	epoch_seconds: z.number().int().positive().describe("Epoch duration in seconds (e.g. 300 for 5-minute trend epochs, 60 for fine-grained)."),
	stats: z
		.array(z.enum(["mean", "min", "max", "sd", "median"]))
		.nonempty()
		.describe("Statistics to compute per epoch per stream."),
	exclude_windows: z
		.array(z.object({ start_sec: z.number().int().nonnegative(), end_sec: z.number().int().nonnegative() }))
		.optional()
		.describe("Second ranges (absolute) to drop before computing stats, e.g. standing-bout windows excluded from a drift analysis."),
	smooth_window_seconds: smoothWindow(),
	start_sec: startSec(),
	end_sec: endSec(),
};

export const ComputeCorrelationWindowInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream_a: streamRef("First stream"),
	stream_b: streamRef("Second stream"),
	start_sec: z.number().int().nonnegative().describe("Window start offset in seconds from activity start."),
	end_sec: z.number().int().nonnegative().describe("Window end offset in seconds (exclusive)."),
	lag_seconds: z
		.number()
		.int()
		.optional()
		.describe("Offset stream_b by this many seconds before correlating. Positive = B lags A. Default: 0. Ignored when lag_scan_seconds is supplied."),
	lag_scan_seconds: z
		.array(z.number().int())
		.nonempty()
		.optional()
		.describe(
			"Lag scan: compute the correlation at each of these lags (seconds) in one call and return a `scan` array plus the `best` (strongest |r|). E.g. [-30,-20,-10,0,10,20,30] to characterise the timing of an inverse relationship. When set, lag_seconds is ignored.",
		),
	smooth_window_seconds: smoothWindow(),
	include_streams: z
		.boolean()
		.optional()
		.describe(
			"If true, also return intermediate_streams — the transformed values of stream_a and stream_b over the window (index 0 = start_sec), so you can inspect the signals that were correlated. Default false.",
		),
};

export const DetectPlateausInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream: streamRef(),
	method: z
		.enum(["absolute", "relative"])
		.describe('"absolute": band is center ± tolerance. "relative": elevated region value ≥ mean + n_sd·sd, computed over the window.'),
	center: z.number().optional().describe("Band centre (required for method=absolute)."),
	tolerance: z.number().positive().optional().describe("Half-width of the stable band (required for method=absolute)."),
	n_sd: z.number().optional().describe("SDs above the window mean for the elevated threshold (required for method=relative; e.g. 1.5)."),
	min_duration_seconds: z.number().int().positive().describe("Minimum plateau length to report, in seconds."),
	smooth_window_seconds: smoothWindow(),
	start_sec: startSec(),
	end_sec: endSec(),
	include_stream: includeStream(),
};

// ── Phase 11 part 2 — shapers (handle producers) + composite ──

const downsampleHz = () =>
	z
		.number()
		.positive()
		.lt(1)
		.optional()
		.describe(
			"Downsample returned values to this rate by bucket-mean — must be < 1 (e.g. 0.1 = one value per 10s). Bucketing uses period = round(1/hz), so the ACTUAL output rate is reported as sample_rate_hz and the input echoed as requested_downsample_hz (they differ for non-1/N rates, e.g. 0.6 → 0.5). Only affects values when return_values is true / on extract_segment.",
		);

export const SmoothStreamInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream: streamRef(),
	window_seconds: z.number().int().positive().describe("Trailing rolling-mean window width in seconds (e.g. SmO₂ 10, HR 5, RMSSD 30)."),
	start_sec: startSec(),
	end_sec: endSec(),
	return_values: z
		.boolean()
		.optional()
		.describe("If true, also return the smoothed values array (optionally downsampled). Default false — only the derived-stream handle + summary are returned, so the high-fidelity series stays server-side."),
	downsample_hz: downsampleHz(),
};

export const ComputeDerivativeInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	stream: streamRef(),
	order: z
		.union([z.literal(1), z.literal(2), z.literal("both")])
		.describe("1 = first derivative (Δ/s), 2 = second derivative (Δ²/s²), \"both\" = return handles for both."),
	smooth_window_seconds: smoothWindow().describe(
		"Trailing rolling mean applied to the SOURCE before differentiating (strongly recommended — raw 1 Hz derivatives are noisy). Equivalent to a ~mean:N op on the source; rejected if the stream ref already has ops.",
	),
	start_sec: startSec(),
	end_sec: endSec(),
	return_values: z.boolean().optional().describe("If true, also return the derivative values array(s). Default false (handle + summary only)."),
	downsample_hz: downsampleHz(),
};

export const ExtractSegmentInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	streams: z.array(streamRef()).nonempty().describe("One or more stream references to materialise over the window."),
	start_sec: z.number().int().nonnegative().describe("Window start offset in seconds from activity start."),
	end_sec: z.number().int().nonnegative().describe("Window end offset in seconds (exclusive)."),
	smooth_window_seconds: smoothWindow().describe("If set, apply a trailing rolling mean to all streams before slicing. Rejected if a ref already has ops."),
	downsample_hz: downsampleHz(),
};

export const AlignEventsToStreamInput = {
	activity_id: z.string().describe("Activity id, e.g. i156869660."),
	streams: z.array(streamRef()).nonempty().describe("One or more stream references to extract around each event."),
	events_sec: z
		.array(z.number().int().nonnegative())
		.nonempty()
		.describe("Event onset timestamps (absolute seconds from activity start), e.g. standing-bout onsets. Use TRUE onsets — if these came from a detector on a smoothed stream, use its estimated_true_sec, not sec."),
	pre_seconds: z.number().int().nonnegative().describe("Seconds before each onset to include."),
	post_seconds: z.number().int().positive().describe("Seconds after each onset to include."),
	smooth_window_seconds: smoothWindow().describe("If set, apply a trailing rolling mean to all streams first. Rejected if a ref already has ops."),
	summary_stats: z
		.boolean()
		.optional()
		.describe("If true, also return mean_by_offset / sd_by_offset across all events per time offset (the average response shape). Default false."),
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
