/**
 * Pure signal-processing primitives over 1 Hz activity streams.
 *
 * Everything here is I/O-free and operates on plain `(number | null)[]` arrays,
 * so it is fully unit-testable against a captured fixture (see test/). Streams
 * carry nulls (sparse sensors, dropout); every function skips nulls in its
 * computation and reports the non-null count (`n`) so the coaching layer can
 * judge data quality. NaN is never emitted — null stands in for "not computable".
 *
 * Indexing convention: a sample's index IS its second offset into the array the
 * function was given. Functions are window-agnostic — callers slice to a window
 * and add the slice's start offset back onto returned `sec` values. The one
 * exception is epochStats, which works in absolute seconds by design.
 *
 * Smoothing is a TRAILING rolling mean (no look-ahead, so it never leaks future
 * samples into an event timestamp); the trailing lag is the window width and is
 * the caller's to compensate for when interpreting event times.
 */

export type Sample = number | null;
export type Series = Sample[];

export type StatName = "mean" | "min" | "max" | "sd" | "median";

/** A derivation step applied to a base stream to form a derived stream. */
export type Op =
	| { op: "trailing_mean"; window_seconds: number }
	| { op: "derivative"; order: 1 | 2 };

const isNum = (v: Sample): v is number => v != null && Number.isFinite(v);

// ── Descriptive statistics (null-skipping) ──

export interface StatsResult {
	/** Count of non-null samples used. */
	n: number;
	mean?: number | null;
	min?: number | null;
	max?: number | null;
	sd?: number | null;
	median?: number | null;
}

function sampleSD(xs: number[]): number | null {
	const n = xs.length;
	if (n < 2) return null;
	const m = xs.reduce((p, c) => p + c, 0) / n;
	const v = xs.reduce((p, c) => p + (c - m) * (c - m), 0) / (n - 1);
	return Math.sqrt(v);
}

function medianOf(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Compute the requested statistics over the non-null samples of `data`. */
export function computeStats(data: Series, names: StatName[]): StatsResult {
	const xs: number[] = [];
	for (const v of data) if (isNum(v)) xs.push(v);
	const res: StatsResult = { n: xs.length };
	for (const name of names) {
		if (xs.length === 0) {
			res[name] = null;
			continue;
		}
		switch (name) {
			case "mean":
				res.mean = xs.reduce((p, c) => p + c, 0) / xs.length;
				break;
			case "min":
				res.min = Math.min(...xs);
				break;
			case "max":
				res.max = Math.max(...xs);
				break;
			case "sd":
				res.sd = sampleSD(xs);
				break;
			case "median":
				res.median = medianOf(xs);
				break;
		}
	}
	return res;
}

/** Convenience: {n_samples, mean, sd, min, max} summary used in stream descriptors. */
export function summarize(data: Series): { n_samples: number; mean: number | null; sd: number | null; min: number | null; max: number | null } {
	const s = computeStats(data, ["mean", "sd", "min", "max"]);
	return { n_samples: s.n, mean: s.mean ?? null, sd: s.sd ?? null, min: s.min ?? null, max: s.max ?? null };
}

// ── Smoothing & derivatives ──

/**
 * Trailing rolling mean over a window of `windowSeconds` (= samples at 1 Hz).
 * Output[i] is the mean of non-null samples in (i-window, i]; null if the window
 * holds no non-null sample. Output is positionally aligned with the input.
 */
export function trailingMean(data: Series, windowSeconds: number): Series {
	const w = Math.max(1, Math.floor(windowSeconds));
	const out: Series = new Array(data.length).fill(null);
	let sum = 0;
	let count = 0;
	for (let i = 0; i < data.length; i++) {
		const entering = data[i];
		if (isNum(entering)) {
			sum += entering;
			count++;
		}
		const leavingIdx = i - w;
		if (leavingIdx >= 0) {
			const leaving = data[leavingIdx];
			if (isNum(leaving)) {
				sum -= leaving;
				count--;
			}
		}
		out[i] = count > 0 ? sum / count : null;
	}
	return out;
}

/**
 * First derivative (Δvalue/s). Central difference where both neighbours exist,
 * else a one-sided difference, else null. Aligned with the input.
 */
export function firstDerivative(data: Series): Series {
	const n = data.length;
	const out: Series = new Array(n).fill(null);
	for (let i = 0; i < n; i++) {
		const prev = i > 0 ? data[i - 1] : null;
		const next = i < n - 1 ? data[i + 1] : null;
		const cur = data[i];
		if (isNum(prev) && isNum(next)) out[i] = (next - prev) / 2;
		else if (isNum(cur) && isNum(next)) out[i] = next - cur;
		else if (isNum(prev) && isNum(cur)) out[i] = cur - prev;
		else out[i] = null;
	}
	return out;
}

/** Second derivative (Δ²value/s²) — the first derivative applied twice. */
export function secondDerivative(data: Series): Series {
	return firstDerivative(firstDerivative(data));
}

/** Apply a single derivation op to a series. */
export function applyOp(data: Series, op: Op): Series {
	switch (op.op) {
		case "trailing_mean":
			return trailingMean(data, op.window_seconds);
		case "derivative":
			return op.order === 2 ? secondDerivative(data) : firstDerivative(data);
	}
}

/** Apply a chain of derivation ops left-to-right. */
export function applyOps(data: Series, ops: Op[]): Series {
	return ops.reduce((acc, op) => applyOp(acc, op), data);
}

// ── Event detection ──

export interface Crossing {
	sec: number;
	direction: "rising" | "falling";
	value_at_crossing: number;
}

function staysBeyond(data: Series, from: number, threshold: number, dir: "rising" | "falling", durationSeconds: number): boolean {
	const end = Math.min(data.length, from + durationSeconds);
	// The stream must be OBSERVED to remain on the far side for the duration. The
	// crossing sample at `from` is beyond by definition, so confirmation requires
	// at least one observed beyond sample AFTER it: an immediate dropout for the
	// whole window (all-null after the cross) cannot confirm the excursion and is
	// rejected. Any observed near-side sample fails. Sparse nulls between
	// confirming samples are tolerated — one dropout shouldn't discard a genuine
	// sustained crossing.
	let observedAfter = false;
	for (let j = from; j < end; j++) {
		const v = data[j];
		if (!isNum(v)) continue;
		if (dir === "rising" && v < threshold) return false;
		if (dir === "falling" && v > threshold) return false;
		if (j > from) observedAfter = true;
	}
	return durationSeconds <= 1 ? true : observedAfter;
}

/**
 * Indices where the stream crosses `threshold` in the requested direction.
 * Comparison walks consecutive non-null samples (nulls are skipped, not treated
 * as zero). `minDurationSeconds` suppresses brief excursions: the stream must
 * stay on the far side of the threshold for at least that long after the cross.
 */
export function thresholdCrossings(
	data: Series,
	threshold: number,
	direction: "rising" | "falling" | "both",
	minDurationSeconds = 0,
): Crossing[] {
	const out: Crossing[] = [];
	let prevVal: number | null = null;
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (!isNum(v)) continue;
		if (prevVal != null) {
			const rising = prevVal < threshold && v >= threshold;
			const falling = prevVal > threshold && v <= threshold;
			if ((rising && direction !== "falling") || (falling && direction !== "rising")) {
				const dir: "rising" | "falling" = rising ? "rising" : "falling";
				if (minDurationSeconds <= 0 || staysBeyond(data, i, threshold, dir, minDurationSeconds)) {
					out.push({ sec: i, direction: dir, value_at_crossing: v });
				}
			}
		}
		prevVal = v;
	}
	return out;
}

export interface PeakEvent {
	sec: number;
	type: "peak" | "nadir";
	value: number;
	prominence: number;
}

function enforceSeparation(events: PeakEvent[], minSeparationSeconds: number): PeakEvent[] {
	if (minSeparationSeconds <= 0) return events;
	// Greedily keep the most prominent events; suppress same-type neighbours
	// within the separation window.
	const byProm = [...events].sort((a, b) => b.prominence - a.prominence);
	const kept: PeakEvent[] = [];
	for (const e of byProm) {
		const clash = kept.some((k) => k.type === e.type && Math.abs(k.sec - e.sec) < minSeparationSeconds);
		if (!clash) kept.push(e);
	}
	return kept;
}

/**
 * Local maxima / minima with a topographic-style prominence filter. Prominence
 * of a peak is its height above the higher of the two surrounding bases (the
 * lowest point reached before rising to a higher peak on each side); nadirs are
 * the mirror image. `minSeparationSeconds` keeps only the most prominent event
 * within any same-type cluster.
 */
export function peaksNadirs(
	data: Series,
	type: "peaks" | "nadirs" | "both",
	minProminence: number,
	minSeparationSeconds = 30,
): PeakEvent[] {
	// Compact to non-null (index, value) pairs so a run of nulls doesn't create
	// spurious extrema.
	const idx: number[] = [];
	const val: number[] = [];
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		if (isNum(v)) {
			idx.push(i);
			val.push(v);
		}
	}
	const m = val.length;
	const events: PeakEvent[] = [];

	const detect = (sign: 1 | -1, label: "peak" | "nadir") => {
		for (let k = 1; k < m - 1; k++) {
			// Local extremum (sign>0 → peak, sign<0 → nadir), tolerating a flat
			// shoulder on the left.
			if (!(sign * val[k] >= sign * val[k - 1] && sign * val[k] > sign * val[k + 1])) continue;
			let leftBase = val[k];
			for (let li = k - 1; li >= 0 && sign * val[li] <= sign * val[k]; li--) {
				if (sign * val[li] < sign * leftBase) leftBase = val[li];
			}
			let rightBase = val[k];
			for (let ri = k + 1; ri < m && sign * val[ri] <= sign * val[k]; ri++) {
				if (sign * val[ri] < sign * rightBase) rightBase = val[ri];
			}
			// Base is the "easier" side to escape to: higher base for a peak,
			// lower base for a nadir.
			const base = sign > 0 ? Math.max(leftBase, rightBase) : Math.min(leftBase, rightBase);
			const prominence = Math.abs(val[k] - base);
			if (prominence >= minProminence) {
				events.push({ sec: idx[k], type: label, value: val[k], prominence });
			}
		}
	};

	if (type !== "nadirs") detect(1, "peak");
	if (type !== "peaks") detect(-1, "nadir");
	return enforceSeparation(events, minSeparationSeconds).sort((a, b) => a.sec - b.sec);
}

// ── Epoch statistics (absolute-second grid) ──

export interface ExcludeWindow {
	start_sec: number;
	end_sec: number;
}

export interface EpochStreamStats extends StatsResult {
	n_excluded: number;
}

export interface Epoch {
	start_sec: number;
	end_sec: number;
	stats: Record<string, EpochStreamStats>;
}

/**
 * Divide one or more streams into a fixed `epochSeconds` grid and compute the
 * requested stats per epoch per stream. Positions inside any `excludeWindows`
 * span are dropped before statistics (e.g. standing-bout windows removed from a
 * drift analysis). Works in absolute seconds: epoch boundaries and exclude
 * windows are activity-second offsets.
 */
export function epochStats(
	streams: Record<string, Series>,
	epochSeconds: number,
	statNames: StatName[],
	opts: { start?: number; end?: number; excludeWindows?: ExcludeWindow[] } = {},
): { epoch_seconds: number; epochs: Epoch[] } {
	const names = Object.keys(streams);
	const maxLen = names.reduce((m, n) => Math.max(m, streams[n].length), 0);
	const start = opts.start ?? 0;
	const end = opts.end ?? maxLen;
	const excl = opts.excludeWindows ?? [];
	const isExcluded = (sec: number) => excl.some((w) => sec >= w.start_sec && sec < w.end_sec);

	const epochs: Epoch[] = [];
	for (let es = start; es < end; es += epochSeconds) {
		const ee = Math.min(es + epochSeconds, end);
		const perStream: Record<string, EpochStreamStats> = {};
		for (const name of names) {
			const arr = streams[name];
			const vals: Series = [];
			let nExcluded = 0;
			for (let sec = es; sec < ee && sec < arr.length; sec++) {
				if (isExcluded(sec)) {
					nExcluded++;
					continue;
				}
				vals.push(arr[sec]);
			}
			perStream[name] = { ...computeStats(vals, statNames), n_excluded: nExcluded };
		}
		epochs.push({ start_sec: es, end_sec: ee, stats: perStream });
	}
	return { epoch_seconds: epochSeconds, epochs };
}

// ── Plateau detection ──

export interface Plateau {
	start_sec: number;
	end_sec: number;
	duration_s: number;
	mean_value: number;
	sd_value: number | null;
}

/**
 * Sustained periods where the stream stays within a band for at least
 * `minDurationSeconds`. Two modes:
 *  - "absolute": band is `center ± tolerance`.
 *  - "relative": band is the ELEVATED region `value ≥ mean + n_sd·sd`, where
 *    mean and sd are computed over the supplied (already windowed) series.
 * Nulls break a run (a dropout ends the plateau). Returned secs are indices into
 * the supplied series; the caller offsets them by any window start.
 */
export function plateaus(
	data: Series,
	opts: {
		method: "absolute" | "relative";
		center?: number;
		tolerance?: number;
		n_sd?: number;
		minDurationSeconds: number;
	},
): Plateau[] {
	let inBand: (v: number) => boolean;
	if (opts.method === "absolute") {
		if (opts.center == null || opts.tolerance == null) {
			throw new Error('plateaus: method "absolute" requires center and tolerance');
		}
		const lo = opts.center - opts.tolerance;
		const hi = opts.center + opts.tolerance;
		inBand = (v) => v >= lo && v <= hi;
	} else {
		if (opts.n_sd == null) throw new Error('plateaus: method "relative" requires n_sd');
		const base = computeStats(data, ["mean", "sd"]);
		if (base.mean == null || base.sd == null) return [];
		const threshold = base.mean + opts.n_sd * base.sd;
		inBand = (v) => v >= threshold;
	}

	const runs: Array<[number, number]> = [];
	let runStart = -1;
	for (let i = 0; i < data.length; i++) {
		const v = data[i];
		const ok = isNum(v) && inBand(v);
		if (ok) {
			if (runStart < 0) runStart = i;
		} else if (runStart >= 0) {
			runs.push([runStart, i]);
			runStart = -1;
		}
	}
	if (runStart >= 0) runs.push([runStart, data.length]);

	return runs
		.filter(([s, e]) => e - s >= opts.minDurationSeconds)
		.map(([s, e]) => {
			const seg = data.slice(s, e);
			const st = computeStats(seg, ["mean", "sd"]);
			return { start_sec: s, end_sec: e, duration_s: e - s, mean_value: st.mean!, sd_value: st.sd ?? null };
		});
}
