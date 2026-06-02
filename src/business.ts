/**
 * Coaching-layer business logic embedded in the server so the calling agent
 * never has to do arithmetic or multi-step orchestration. These rules are the
 * primary reason this server exists over a generic API wrapper.
 *
 * See docs decision log and the project handover for provenance.
 */

/** Rule 1 — load calculation for WeightTraining only. */
export function computeWeightTrainingLoad(rpe: number, durationMinutes: number): number {
	return Math.round(rpe * durationMinutes * 0.15);
}

/**
 * Apply Rule 1 to an event/activity body in place.
 *
 * Only fires when:
 *   - type is WeightTraining, AND
 *   - rpe and duration_minutes are both provided, AND
 *   - icu_training_load was NOT explicitly provided.
 *
 * For Ride/VirtualRide/etc. the load is derived by intervals.icu from power/HR;
 * overwriting it corrupts TSS, so we never auto-compute for those types.
 */
export function applyRule1(
	body: Record<string, unknown>,
	ctx: { type?: string; rpe?: number; duration_minutes?: number; icu_training_load?: number },
): void {
	const hasExplicitLoad =
		ctx.icu_training_load !== undefined || body.icu_training_load !== undefined;
	if (
		ctx.type === "WeightTraining" &&
		ctx.rpe !== undefined &&
		ctx.duration_minutes !== undefined &&
		!hasExplicitLoad
	) {
		body.icu_training_load = computeWeightTrainingLoad(ctx.rpe, ctx.duration_minutes);
	}
}

/** Structured readiness flags derived from PMC values for the most recent record. */
export function fitnessFlags(ctl?: number | null, atl?: number | null, tsb?: number | null) {
	return {
		// Negative TSB below −15 indicates accumulated fatigue / overreaching risk.
		overreachRisk: typeof tsb === "number" ? tsb < -15 : false,
		// Acute load spiking well above chronic load.
		fatigueSpike:
			typeof atl === "number" && typeof ctl === "number" ? atl > ctl + 10 : false,
	};
}

/**
 * hrvTrendDown — true when HRV has declined over 3+ consecutive days within the
 * supplied (date-ascending) series. Records without an hrv value are skipped.
 */
export function hrvTrendDown(records: { date?: string; hrv?: number | null }[]): boolean {
	const series = records
		.filter((r) => typeof r.hrv === "number")
		.sort((a, b) => String(a.date).localeCompare(String(b.date)));
	let consecutiveDeclines = 0;
	for (let i = 1; i < series.length; i++) {
		if ((series[i].hrv as number) < (series[i - 1].hrv as number)) {
			consecutiveDeclines++;
			if (consecutiveDeclines >= 3) return true;
		} else {
			consecutiveDeclines = 0;
		}
	}
	return false;
}
