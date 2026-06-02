/**
 * Runtime configuration for the Intervals.icu MCP server.
 *
 * Upstream auth is HTTP Basic: username is the literal string "API_KEY" and the
 * password is the personal API key (INTERVALS_API_KEY). This is the scheme
 * intervals.icu documents for personal-key access.
 */

export interface IntervalsConfig {
	apiKey: string;
	athleteId: string;
	baseUrl: string;
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`[intervals-mcp] Missing required env var: ${name}`);
		process.exit(1);
	}
	return v;
}

export function loadConfig(): IntervalsConfig {
	const apiKey = requireEnv("INTERVALS_API_KEY");
	const athleteId = process.env.INTERVALS_ATHLETE_ID || "0";
	const baseUrl = (process.env.INTERVALS_BASE_URL || "https://intervals.icu").replace(/\/+$/, "");
	console.error(
		`[intervals-mcp] config: athleteId=${athleteId} baseUrl=${baseUrl} apiKey=${apiKey ? "set" : "MISSING"}`,
	);
	return { apiKey, athleteId, baseUrl };
}
