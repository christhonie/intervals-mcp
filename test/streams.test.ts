/**
 * Tests for the stream reference resolver, derived-stream handles, and cache.
 * Uses a stub client that counts upstream calls — no network, no fixture needed.
 */

import { describe, it, expect } from "vitest";
import { parseRef, formatHandle, StreamService } from "../src/streams.js";

/** Minimal stub matching the one method StreamService uses. */
function stubClient(streams: Record<string, (number | null)[]>) {
	let calls = 0;
	const client = {
		getActivityStreams(_id: string, types: string[]) {
			calls++;
			// Model the API's aliasing: a request for fixed_watts comes back as watts.
			return Promise.resolve(
				types
					.map((t) => (t === "fixed_watts" ? "watts" : t))
					.filter((t) => streams[t] != null)
					.map((t) => ({ type: t, data: streams[t] })),
			);
		},
	};
	return { client: client as any, calls: () => calls };
}

describe("streams.ts — references & handles", () => {
	it("parses raw names and derived handles", () => {
		expect(parseRef("smo2")).toMatchObject({ source: "smo2", ops: [], handle: "smo2" });
		expect(parseRef("velocity_smooth")).toMatchObject({ source: "velocity_smooth", ops: [] });
		expect(parseRef("smo2~mean:10")).toMatchObject({
			source: "smo2",
			ops: [{ op: "trailing_mean", window_seconds: 10 }],
			handle: "smo2~mean:10",
		});
		expect(parseRef("smo2~mean:10~d:1").ops).toEqual([
			{ op: "trailing_mean", window_seconds: 10 },
			{ op: "derivative", order: 1 },
		]);
	});

	it("formatHandle round-trips", () => {
		const ops = parseRef("watts~mean:30~d:2").ops;
		expect(formatHandle("watts", ops)).toBe("watts~mean:30~d:2");
	});

	it("rejects malformed references", () => {
		expect(() => parseRef("smo2~mean:0")).toThrow();
		expect(() => parseRef("smo2~d:3")).toThrow();
		expect(() => parseRef("smo2~bogus:1")).toThrow();
	});

	it("resolves a raw stream and caches it (one upstream call)", async () => {
		const { client, calls } = stubClient({ smo2: [1, 2, 3, 4] });
		const svc = new StreamService(client);
		const a = await svc.resolve("i1", "smo2");
		const b = await svc.resolve("i1", "smo2");
		expect(a.values).toEqual([1, 2, 3, 4]);
		expect(b.values).toEqual([1, 2, 3, 4]);
		expect(calls()).toBe(1); // second resolve served from cache
	});

	it("computes a derived stream and reuses the cached source", async () => {
		const { client, calls } = stubClient({ smo2: [10, 20, 30, 40] });
		const svc = new StreamService(client);
		const raw = await svc.resolve("i1", "smo2");
		const smoothed = await svc.resolve("i1", "smo2~mean:2");
		expect(calls()).toBe(1); // derived stream reused the already-fetched source
		// trailing mean window 2: [10, 15, 25, 35]
		expect(smoothed.values).toEqual([10, 15, 25, 35]);
		expect(raw.values).toEqual([10, 20, 30, 40]);
	});

	it("recompute-on-miss: a derived handle is recomputed after eviction", async () => {
		const { client, calls } = stubClient({ smo2: [10, 20, 30, 40], heartrate: [1, 2, 3, 4] });
		const svc = new StreamService(client, 10 * 60 * 1000, 1); // capacity 1 evicts aggressively
		await svc.resolve("i1", "smo2~mean:2"); // fetch smo2 (1)
		await svc.resolve("i1", "heartrate"); // fetch heartrate (2), evicts the derived handle
		const again = await svc.resolve("i1", "smo2~mean:2"); // miss → refetch smo2 (3), recompute
		expect(again.values).toEqual([10, 15, 25, 35]); // correct despite the dropped cache
		expect(calls()).toBe(3); // it recomputed from the handle, not a dangling reference
	});

	it("batches distinct sources in resolveMany and reports missing as null", async () => {
		const { client, calls } = stubClient({ smo2: [1, 2], heartrate: [100, 110] });
		const svc = new StreamService(client);
		const map = await svc.resolveMany("i1", ["smo2", "heartrate", "dfa_a1"]);
		expect(calls()).toBe(1); // one upstream call for all three
		expect(map.get("smo2")!.values).toEqual([1, 2]);
		expect(map.get("dfa_a1")!.values).toBeNull();
	});

	it("resolves fixed_watts via the watts alias", async () => {
		const { client } = stubClient({ watts: [200, 210, 220] });
		const svc = new StreamService(client);
		const r = await svc.resolve("i1", "fixed_watts");
		expect(r.values).toEqual([200, 210, 220]);
	});
});
