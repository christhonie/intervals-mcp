/**
 * Calibration tests for src/signal.ts.
 *
 * The expected values come from the Signal Processing Toolkit requirements doc,
 * which derived them from a real analysis of activity i156869660 (2026-06-13).
 * test/fixtures/streams-i156869660.json holds that activity's raw streams,
 * captured once via scripts/capture-streams-fixture.mjs. These tests pin the
 * primitives to the documented baselines so the toolkit reproduces them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
	trailingMean,
	computeStats,
	peaksNadirs,
	thresholdCrossings,
	epochStats,
	plateaus,
	type Series,
} from "../src/signal.js";
import { pearson } from "../src/stats.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw: Array<{ type: string; data: Series }> = JSON.parse(
	readFileSync(join(here, "fixtures/streams-i156869660.json"), "utf8"),
);
const S: Record<string, Series> = Object.fromEntries(raw.map((s) => [s.type, s.data]));

const MAIN_START = 602;
const MAIN_END = 3902;
// Standing-bout onsets (SmO2 drop start) from the doc's align example.
const BOUT_ONSETS = [1222, 2010, 2812, 3633, 3901];
const EXPECTED_NADIRS = [1238, 2018, 2823, 3641, 3908];

/** Is `sec` within ±tol of any expected value? */
const near = (sec: number, expected: number[], tol = 25) => expected.some((e) => Math.abs(sec - e) <= tol);

describe("signal.ts — calibration against i156869660", () => {
	it("fixture loaded with expected streams", () => {
		expect(S.smo2?.length).toBe(4206);
		expect(Object.keys(S).sort()).toEqual(["RMSSD", "dfa_a1", "heartrate", "smo2", "time", "watts"]);
	});

	it("smooth_stream(smo2, 10s) main-set mean ≈ 62.6%", () => {
		const sm = trailingMean(S.smo2, 10).slice(MAIN_START, MAIN_END);
		const { mean } = computeStats(sm, ["mean"]);
		expect(mean).toBeCloseTo(62.6, 0); // within 0.5
		expect(mean!).toBeGreaterThan(62.3);
		expect(mean!).toBeLessThan(62.9);
	});

	it("RMSSD main-set mean ≈ 2.18 ms, sd ≈ 0.54 ms", () => {
		const { mean, sd } = computeStats(S.RMSSD.slice(MAIN_START, MAIN_END), ["mean", "sd"]);
		expect(mean).toBeCloseTo(2.18, 1);
		expect(sd).toBeCloseTo(0.54, 1);
	});

	it("detect_peaks_nadirs(smo2, nadirs) isolates the 5 standing bouts", () => {
		const sm = trailingMean(S.smo2, 10);
		const window = sm.slice(MAIN_START, 4100);
		// NB: the doc suggests prominence 3.0, but on 10s-smoothed SmO2 that also
		// catches the ~3% wiggle of the Z2 plateau (10 nadirs total). The five
		// standing bouts are deep (prominence 7.4–13.7) and cleanly separate from
		// noise at prominence ≥ 5.0 — see the validation note in ADR-014.
		const bouts = peaksNadirs(window, "nadirs", 5.0, 30).map((e) => ({ ...e, sec: e.sec + MAIN_START }));
		expect(bouts.length).toBe(5);
		for (const n of bouts) {
			expect(near(n.sec, EXPECTED_NADIRS)).toBe(true);
			expect(n.value).toBeGreaterThan(48);
			expect(n.value).toBeLessThan(58);
		}
		// At prominence 3.0 every bout is still present (plus plateau noise).
		const loose = peaksNadirs(window, "nadirs", 3.0, 30).map((e) => e.sec + MAIN_START);
		for (const expected of EXPECTED_NADIRS) expect(loose.some((s) => Math.abs(s - expected) <= 25)).toBe(true);
	});

	it("detect_threshold_crossings(smo2, smooth=10s, falling) finds bout onsets", () => {
		const sm = trailingMean(S.smo2, 10);
		const window = sm.slice(MAIN_START, 4100);
		// Threshold 57 catches all five onsets; 55 catches only four because bout 4
		// (onset ~3633) is shallow — its smoothed SmO2 bottoms out at 56.4%, never
		// reaching 55. This is a genuine data finding, not a detector bug (ADR-014).
		const at57 = thresholdCrossings(window, 57, "falling", 5).map((c) => c.sec + MAIN_START);
		expect(at57.length).toBe(5);
		for (const c of at57) expect(near(c, BOUT_ONSETS, 30)).toBe(true);

		const at55 = thresholdCrossings(window, 55, "falling", 5).map((c) => c.sec + MAIN_START);
		expect(at55.length).toBe(4);
	});

	it("compute_epoch_stats([smo2,dfa_a1], 1200s, exclude bouts) → clean drift", () => {
		const excludeWindows = BOUT_ONSETS.map((o) => ({ start_sec: o - 30, end_sec: o + 150 }));
		const { epochs } = epochStats({ smo2: S.smo2, dfa_a1: S.dfa_a1 }, 1200, ["mean"], {
			start: MAIN_START,
			end: MAIN_END,
			excludeWindows,
		});
		expect(epochs.length).toBe(3);
		const first = epochs[0].stats.smo2.mean!;
		const last = epochs[epochs.length - 1].stats.smo2.mean!;
		expect(first).toBeCloseTo(62.68, 0);
		expect(last).toBeCloseTo(63.33, 0);
		expect(epochs[0].stats.smo2.n_excluded).toBeGreaterThan(0);
		// dfa_a1 present in every epoch.
		for (const e of epochs) expect(e.stats.dfa_a1.n).toBeGreaterThan(0);
	});

	it("detect_plateaus(RMSSD, relative, n_sd=1.5, min_dur=20s) → 3 plateaus", () => {
		const window = S.RMSSD.slice(MAIN_START, MAIN_END);
		const found = plateaus(window, { method: "relative", n_sd: 1.5, minDurationSeconds: 20 }).map((p) => ({
			...p,
			start_sec: p.start_sec + MAIN_START,
			end_sec: p.end_sec + MAIN_START,
		}));
		expect(found.length).toBe(3);
	});

	it("compute_correlation_window(watts, heartrate) over main set is positive & significant", () => {
		const a = S.watts.slice(MAIN_START, MAIN_END);
		const b = S.heartrate.slice(MAIN_START, MAIN_END);
		const { n, r, p } = pearson(a, b);
		expect(n).toBeGreaterThan(1000);
		expect(r!).toBeGreaterThan(0); // power and HR move together
		expect(r!).toBeLessThanOrEqual(1);
		expect(p!).toBeLessThan(0.05); // large n ⇒ clearly significant
	});

	it("pearson is null-safe and exact on a known relationship", () => {
		// Perfect linear relationship y = 2x, with nulls interspersed.
		const x: Series = [1, 2, null, 3, 4, 5, null];
		const y: Series = [2, 4, 9, 6, 8, 10, null];
		const { n, r } = pearson(x, y);
		expect(n).toBe(5);
		expect(r!).toBeCloseTo(1, 5);
	});
});
