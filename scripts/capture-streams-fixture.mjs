/**
 * One-off: capture the raw streams for the calibration activity (i156869660)
 * into a test fixture, so the signal-processing unit tests can run offline.
 *
 * Run with the API key supplied via Node's env-file loader (never printed):
 *   node --env-file .env scripts/capture-streams-fixture.mjs
 *
 * Writes test/fixtures/streams-i156869660.json — an array of
 * { type, data } ActivityStream objects, exactly as the Intervals.icu API
 * returns them (see ADR-013). Not committed secrets; just the numeric streams.
 */

import { writeFileSync } from "node:fs";

const ACTIVITY = "i156869660";
const STREAMS = ["smo2", "heartrate", "watts", "dfa_a1", "RMSSD", "time"];

const apiKey = process.env.INTERVALS_API_KEY;
if (!apiKey) {
	console.error("Missing INTERVALS_API_KEY (run with: node --env-file .env ...)");
	process.exit(1);
}
const baseUrl = (process.env.INTERVALS_BASE_URL || "https://intervals.icu").replace(/\/+$/, "");

const auth = "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64");
const url = new URL(`${baseUrl}/api/v1/activity/${ACTIVITY}/streams`);
for (const s of STREAMS) url.searchParams.append("types", s);

const res = await fetch(url, { headers: { Authorization: auth, Accept: "application/json" } });
if (!res.ok) {
	console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
	process.exit(1);
}
const body = await res.json();

// Keep only the numeric stream payloads (type + data); drop bulky/derived fields.
const slim = (Array.isArray(body) ? body : []).map((s) => ({ type: s.type, data: s.data }));
const out = "test/fixtures/streams-i156869660.json";
writeFileSync(out, JSON.stringify(slim));
const summary = slim.map((s) => `${s.type}:${Array.isArray(s.data) ? s.data.length : "?"}`).join(" ");
console.log(`Wrote ${out} — ${summary}`);
