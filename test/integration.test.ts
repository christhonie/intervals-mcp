/**
 * Integration: the derived-handle pipeline the Phase 11 tools rely on —
 * StreamService.resolve("smo2~mean:10") → window → reducer — must reproduce the
 * calibration results that signal.test.ts proves with manual smoothing. This
 * exercises the resolver + ops replay together with the numerics, the way the
 * registered tools wire them, using a fixture-backed stub client (no network).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { StreamService } from "../src/streams.js";
import { thresholdCrossings, peaksNadirs, epochStats, alignWindows, type Series } from "../src/signal.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw: Array<{ type: string; data: Series }> = JSON.parse(
	readFileSync(join(here, "fixtures/streams-i156869660.json"), "utf8"),
);
const FIX: Record<string, Series> = Object.fromEntries(raw.map((s) => [s.type, s.data]));

function fixtureService() {
	let calls = 0;
	const client = {
		getActivityStreams(_id: string, types: string[]) {
			calls++;
			return Promise.resolve(types.filter((t) => FIX[t] != null).map((t) => ({ type: t, data: FIX[t] })));
		},
	};
	return { svc: new StreamService(client as any), calls: () => calls };
}

const MAIN_START = 602;
const near = (sec: number, expected: number[], tol = 30) => expected.some((e) => Math.abs(sec - e) <= tol);

describe("integration — Phase 11 tool pipeline over the fixture", () => {
	it("detect_threshold_crossings path (smo2~mean:10, threshold 57) → 5 bout onsets", async () => {
		const { svc } = fixtureService();
		const resolved = await svc.resolve("i156869660", "smo2~mean:10");
		const window = resolved.values!.slice(MAIN_START, 4100);
		const crossings = thresholdCrossings(window, 57, "falling", 5).map((c) => c.sec + MAIN_START);
		expect(crossings.length).toBe(5);
		for (const c of crossings) expect(near(c, [1222, 2010, 2812, 3633, 3901])).toBe(true);
	});

	it("detect_peaks_nadirs path (smo2~mean:10, prominence 5) → 5 nadirs", async () => {
		const { svc } = fixtureService();
		const resolved = await svc.resolve("i156869660", "smo2~mean:10");
		const window = resolved.values!.slice(MAIN_START, 4100);
		const nadirs = peaksNadirs(window, "nadirs", 5, 30);
		expect(nadirs.length).toBe(5);
	});

	it("compute_epoch_stats path resolves multiple streams in one upstream call", async () => {
		const { svc, calls } = fixtureService();
		const map = await svc.resolveMany("i156869660", ["smo2", "dfa_a1"]);
		expect(calls()).toBe(1); // both streams fetched together
		const streams = { smo2: map.get("smo2")!.values!, dfa_a1: map.get("dfa_a1")!.values! };
		const { epochs } = epochStats(streams, 1200, ["mean"], {
			start: MAIN_START,
			end: 3902,
			excludeWindows: [1222, 2010, 2812, 3633, 3901].map((o) => ({ start_sec: o - 30, end_sec: o + 150 })),
		});
		expect(epochs.length).toBe(3);
		expect(epochs[0].stats.smo2.mean!).toBeCloseTo(62.68, 0);
	});

	it("align_events_to_stream path reproduces per-bout SmO2 nadirs", async () => {
		const { svc } = fixtureService();
		const map = await svc.resolveMany("i156869660", ["smo2", "heartrate"]);
		const streams = { smo2: map.get("smo2")!.values!, heartrate: map.get("heartrate")!.values! };
		const { length, events } = alignWindows(streams, [1222, 2010, 2812, 3633, 3901], 30, 150);
		expect(length).toBe(180); // pre 30 + post 150
		expect(events).toHaveLength(5);
		// Per-bout raw SmO2 nadir within each window (calibration table).
		const expected = [52.0, 52.0, 50.9, 54.8, 51.9];
		const nadirs = events.map((e) => Math.min(...e.windows.smo2.filter((v): v is number => v != null)));
		nadirs.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 0));
		// Both requested streams present in every aligned window.
		for (const e of events) {
			expect(e.windows.smo2).toHaveLength(180);
			expect(e.windows.heartrate).toHaveLength(180);
		}
	});
});
