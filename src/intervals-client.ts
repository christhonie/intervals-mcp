/**
 * Thin typed HTTP client for the Intervals.icu REST API.
 *
 * A hand-rolled client (rather than generated) is deliberate: the published
 * OpenAPI spec uses Spring content-negotiation path suffixes ({format}/{ext})
 * that don't map cleanly onto codegen clients, and we touch only ~10 endpoints.
 * The spec is kept in openapi-spec.json as the source of truth for field names.
 *
 * Error surfacing follows the remote-mcp-wrap skill: every non-2xx response
 * throws a descriptive Error so the MCP SDK reports `isError:true` with detail,
 * instead of a handler returning `text(undefined)` (an opaque client error).
 */

import type { IntervalsConfig } from "./config.js";

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];
export type Query = Record<string, QueryValue>;

/** Ensure an activity id is in the canonical `i`-prefixed form (e.g. i150320999). */
export function normalizeActivityId(id: string | number): string {
	const s = String(id).trim();
	return /^i/i.test(s) ? s : `i${s}`;
}

export class IntervalsApiError extends Error {
	constructor(
		public status: number,
		public method: string,
		public path: string,
		public body: string,
	) {
		super(`Intervals.icu API error: HTTP ${status} on ${method} ${path}${body ? ` — ${body}` : ""}`);
		this.name = "IntervalsApiError";
	}
}

export class IntervalsClient {
	private readonly authHeader: string;
	private readonly baseUrl: string;
	readonly athleteId: string;

	constructor(cfg: IntervalsConfig) {
		this.baseUrl = cfg.baseUrl;
		this.athleteId = cfg.athleteId;
		// HTTP Basic: username "API_KEY", password = personal API key.
		this.authHeader = "Basic " + Buffer.from(`API_KEY:${cfg.apiKey}`).toString("base64");
	}

	private buildUrl(path: string, query?: Query): string {
		const url = new URL(this.baseUrl + path);
		if (query) {
			for (const [k, v] of Object.entries(query)) {
				if (v === undefined || v === null) continue;
				if (Array.isArray(v)) {
					for (const item of v) url.searchParams.append(k, String(item));
				} else {
					url.searchParams.set(k, String(v));
				}
			}
		}
		return url.toString();
	}

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		opts: { query?: Query; body?: unknown } = {},
	): Promise<T> {
		const url = this.buildUrl(path, opts.query);
		const headers: Record<string, string> = {
			Authorization: this.authHeader,
			Accept: "application/json",
		};
		if (opts.body !== undefined) headers["Content-Type"] = "application/json";

		const res = await fetch(url, {
			method,
			headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		});

		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 2000);
			} catch {
				/* ignore */
			}
			throw new IntervalsApiError(res.status, method, path, detail);
		}

		// Some endpoints (e.g. DELETE) may return an empty body.
		const textBody = await res.text();
		if (!textBody) return undefined as T;
		try {
			return JSON.parse(textBody) as T;
		} catch {
			return textBody as unknown as T;
		}
	}

	private athletePath(suffix: string): string {
		return `/api/v1/athlete/${this.athleteId}${suffix}`;
	}

	// ── Activities ──

	listActivities(query: { oldest: string; newest?: string; limit?: number }): Promise<any[]> {
		return this.request("GET", this.athletePath("/activities"), { query });
	}

	getActivity(activityId: string): Promise<any> {
		return this.request("GET", `/api/v1/activity/${normalizeActivityId(activityId)}`);
	}

	updateActivity(activityId: string, body: Record<string, unknown>): Promise<any> {
		return this.request("PUT", `/api/v1/activity/${normalizeActivityId(activityId)}`, { body });
	}

	createManualActivity(body: Record<string, unknown>): Promise<any> {
		return this.request("POST", this.athletePath("/activities/manual"), { body });
	}

	// ── Events / Calendar ──

	listEvents(query: {
		oldest?: string;
		newest?: string;
		category?: string | string[];
		resolve?: boolean;
	}): Promise<any[]> {
		return this.request("GET", this.athletePath("/events"), { query });
	}

	getEvent(eventId: number | string): Promise<any> {
		return this.request("GET", this.athletePath(`/events/${eventId}`));
	}

	/** POST a single calendar event. upsertOnUid is a required query param. */
	createEvent(body: Record<string, unknown>, upsertOnUid = false): Promise<any> {
		return this.request("POST", this.athletePath("/events"), {
			query: { upsertOnUid },
			body,
		});
	}

	updateEvent(eventId: number | string, body: Record<string, unknown>): Promise<any> {
		return this.request("PUT", this.athletePath(`/events/${eventId}`), { body });
	}

	// ── Wellness ──

	listWellness(query: { oldest?: string; newest?: string }): Promise<any[]> {
		return this.request("GET", this.athletePath("/wellness"), { query });
	}

	// ── Performance ──

	/**
	 * Athlete power curves. NOTE: this endpoint has several required params
	 * (type, f1, f2, f3) whose exact semantics need live validation — see the
	 * decision log. We pass empty filter arrays and a sport type.
	 */
	listPowerCurves(query: Query): Promise<any> {
		return this.request("GET", this.athletePath("/power-curves"), { query });
	}

	// ── Plan / Library ──

	listFolders(): Promise<any[]> {
		return this.request("GET", this.athletePath("/folders"));
	}

	applyPlan(body: { folder_id: number; start_date_local: string; extra_workouts?: unknown[] }): Promise<any> {
		return this.request("POST", this.athletePath("/events/apply-plan"), { body });
	}
}
