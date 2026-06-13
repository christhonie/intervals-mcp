/**
 * Stream resolution, derived-stream handles, and a short-lived in-memory cache.
 *
 * Every signal-processing tool takes a "stream reference" that is either a raw
 * stream name (`smo2`, `velocity_smooth`, `RMSSD`) or a DERIVED-STREAM HANDLE
 * describing a chain of ops applied to a raw stream:
 *
 *     <source>[~<op>:<params>...]      e.g.  smo2~mean:10~d:1
 *       mean:<n>  trailing rolling mean over n seconds
 *       d:<1|2>   first / second derivative
 *
 * Handles are deterministic and self-describing: a handle IS the recipe to
 * recompute the stream. The cache is therefore a pure optimisation — on a miss
 * (eviction, TTL expiry, or a pod rollout, all routine on this single-replica
 * server) any tool recomputes from the handle by fetching the source and
 * replaying the ops. Correctness never depends on cache liveness. A raw name is
 * just a degenerate handle (a source with no ops), so one resolver covers both.
 *
 * `~` and `:` are safe delimiters: Intervals.icu stream names use only letters,
 * digits and underscore (e.g. velocity_smooth, dfa_a1, RMSSD).
 */

import type { IntervalsClient } from "./intervals-client.js";
import { normalizeActivityId } from "./intervals-client.js";
import { applyOps, type Op, type Series } from "./signal.js";

/**
 * Stream names the API returns under a different `type` than requested. Per the
 * OpenAPI description the endpoint "will return 'fixed_watts' as 'watts'". Used
 * to resolve a requested source against the returned stream so a present stream
 * isn't mis-reported as missing. (`raw_watts` comes back under its own name.)
 */
export const STREAM_TYPE_ALIASES: Record<string, string> = { fixed_watts: "watts" };

export interface StreamRef {
	source: string;
	ops: Op[];
	/** Canonical, deterministic handle for this reference. */
	handle: string;
}

/** Format a source + op chain into its canonical handle string. */
export function formatHandle(source: string, ops: Op[]): string {
	const toks = ops.map((o) => (o.op === "trailing_mean" ? `mean:${o.window_seconds}` : `d:${o.order}`));
	return [source, ...toks].join("~");
}

/** Parse a stream reference (raw name or derived handle) into source + ops. */
export function parseRef(ref: string): StreamRef {
	const parts = String(ref).split("~");
	const source = parts[0];
	if (!source) throw new Error(`Invalid stream reference: "${ref}"`);
	const ops: Op[] = [];
	for (const tok of parts.slice(1)) {
		const [name, arg] = tok.split(":");
		if (name === "mean") {
			// Windows must be positive integers. Handles are deterministic recipes,
			// so a fractional window (which would silently floor — "mean:0.5" →
			// "mean:0", colliding handles and yielding an invalid 0-width window) is
			// rejected rather than coerced.
			const w = Number(arg);
			if (!Number.isInteger(w) || w <= 0) {
				throw new Error(`mean window must be a positive integer in "${ref}", got "${arg}"`);
			}
			ops.push({ op: "trailing_mean", window_seconds: w });
		} else if (name === "d") {
			const order = Number(arg);
			if (order !== 1 && order !== 2) throw new Error(`Derivative order must be 1 or 2 in "${ref}", got "${arg}"`);
			ops.push({ op: "derivative", order });
		} else {
			throw new Error(`Unknown op "${name}" in stream reference "${ref}"`);
		}
	}
	return { source, ops, handle: formatHandle(source, ops) };
}

export interface ResolvedStream {
	handle: string;
	source: string;
	ops: Op[];
	/** Full-length, positionally-aligned values, or null if the source is absent. */
	values: Series | null;
}

interface CacheEntry {
	values: Series | null;
	expires: number;
}

/**
 * Resolves stream references against the Intervals.icu API, caching both raw
 * source streams and computed derived streams in memory. Keyed by
 * `${activityId}::${handle}` (a raw source's handle is just its name).
 */
export class StreamService {
	private cache = new Map<string, CacheEntry>();

	constructor(
		private client: IntervalsClient,
		private ttlMs = 10 * 60 * 1000,
		private maxEntries = 64,
	) {}

	private read(key: string): Series | null | undefined {
		const e = this.cache.get(key);
		if (!e) return undefined;
		if (e.expires < Date.now()) {
			this.cache.delete(key);
			return undefined;
		}
		// Move to end for LRU recency.
		this.cache.delete(key);
		this.cache.set(key, e);
		return e.values;
	}

	private write(key: string, values: Series | null): void {
		this.cache.set(key, { values, expires: Date.now() + this.ttlMs });
		while (this.cache.size > this.maxEntries) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
	}

	/**
	 * Fetch one or more RAW source streams, using the cache and batching all
	 * uncached names into a single upstream call. Returns a map name → values
	 * (null when the activity lacks that stream). Honours the fixed_watts alias.
	 */
	async getSources(activityId: string, names: string[]): Promise<Map<string, Series | null>> {
		const id = normalizeActivityId(activityId);
		const result = new Map<string, Series | null>();
		const missing: string[] = [];
		for (const name of names) {
			const hit = this.read(`${id}::${name}`);
			if (hit !== undefined) result.set(name, hit);
			else if (!missing.includes(name)) missing.push(name);
		}
		if (missing.length) {
			const raw = (await this.client.getActivityStreams(id, missing)) ?? [];
			const byType = new Map<string, Series>();
			for (const s of raw) {
				// Only accept an actual sample array. A stream whose `data` is not an
				// array is treated as absent (resolves to null below) rather than as
				// "present but empty", so a malformed upstream response is not silently
				// masked into downstream duration/stat calculations.
				if (s && s.type != null && Array.isArray(s.data)) byType.set(String(s.type), s.data);
			}
			for (const name of missing) {
				const alias = STREAM_TYPE_ALIASES[name];
				const vals = byType.get(name) ?? (alias ? byType.get(alias) : undefined) ?? null;
				this.write(`${id}::${name}`, vals);
				result.set(name, vals);
			}
		}
		return result;
	}

	/**
	 * Resolve a single stream reference (raw name or derived handle) to its
	 * full-length values, computing and caching derived streams as needed.
	 */
	async resolve(activityId: string, ref: string): Promise<ResolvedStream> {
		const id = normalizeActivityId(activityId);
		const { source, ops, handle } = parseRef(ref);
		const cached = this.read(`${id}::${handle}`);
		if (cached !== undefined) return { handle, source, ops, values: cached };

		const base = (await this.getSources(id, [source])).get(source) ?? null;
		const values = base == null ? null : ops.length ? applyOps(base, ops) : base;
		if (ops.length) this.write(`${id}::${handle}`, values);
		return { handle, source, ops, values };
	}

	/**
	 * Resolve several references, warming the cache with a single upstream call
	 * for all distinct source streams first. Returns a map keyed by the original
	 * reference strings.
	 */
	async resolveMany(activityId: string, refs: string[]): Promise<Map<string, ResolvedStream>> {
		const id = normalizeActivityId(activityId);
		const parsed = refs.map((r) => ({ ref: r, ...parseRef(r) }));
		const sources = [...new Set(parsed.map((p) => p.source))];
		await this.getSources(id, sources); // one batched fetch
		const out = new Map<string, ResolvedStream>();
		for (const r of refs) out.set(r, await this.resolve(id, r));
		return out;
	}
}
