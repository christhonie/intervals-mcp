/**
 * Date helpers. All Intervals.icu calendar/wellness queries use local date
 * strings (YYYY-MM-DD) without a time component.
 *
 * NOTE: default ranges are computed from the server clock (UTC). The coaching
 * agent should pass explicit dates for anything date-sensitive; defaults are a
 * convenience only. See the IcuSync date-accuracy guidance.
 */

export function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

export function today(): string {
	return formatDate(new Date());
}

export function daysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return formatDate(d);
}

export function daysFromNow(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + n);
	return formatDate(d);
}

/** Add days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dateStr: string, n: number): string {
	const d = new Date(dateStr + "T00:00:00Z");
	d.setUTCDate(d.getUTCDate() + n);
	return formatDate(d);
}

/**
 * Intervals.icu event POSTs require a full ISO datetime for start/end dates
 * (a bare YYYY-MM-DD is rejected with "Invalid start date"). Append midnight
 * when only a date is supplied; pass through anything that already has a time.
 */
export function toDateTime(d: string): string {
	return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00` : d;
}

/** 0 = Sunday … 1 = Monday … 6 = Saturday (UTC). */
export function dayOfWeek(dateStr: string): number {
	return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

export function isMonday(dateStr: string): boolean {
	return dayOfWeek(dateStr) === 1;
}

/** Monday of the ISO week containing the given date. */
export function weekStartMonday(dateStr: string): string {
	const dow = dayOfWeek(dateStr);
	const delta = dow === 0 ? -6 : 1 - dow; // shift back to Monday
	return addDays(dateStr, delta);
}
