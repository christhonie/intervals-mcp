/**
 * Zod input schemas (raw shapes) for each MCP tool. The MCP SDK's registerTool
 * expects a ZodRawShape (a plain object of zod types), not a z.object().
 */

import { z } from "zod";

const isoDate = () => z.string().regex(/^\d{4}-\d{2}-\d{2}/, "Expected ISO date YYYY-MM-DD");

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
		.min(1)
		.describe(
			"One entry per sport. Each becomes a separate TARGET event in the week. All existing TARGET events in the week are replaced.",
		),
};

export const ApplyPlanInput = {
	folder_id: z.number().int().describe("Plan-library folder id (see list_plan_folders)."),
	start_date_local: z.string().describe("Start date (ISO). Must be a Monday."),
};

export const ListPlanFoldersInput = {};
