/**
 * Drift guard: the README "Tools" table (between the TOOLS:START / TOOLS:END
 * markers) must list exactly the tools registered in src/server.ts, with the
 * correct phase. The table's "Notes" column is curated by hand — this test does
 * NOT generate it; it only fails the build when a tool is added/removed/renamed
 * (or moved to another phase) without the README following. That is the failure
 * mode we actually hit: Phase 9/10/11 shipped while the table was stuck at 1–3.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

type Tool = { name: string; phase: string };

/**
 * Parse the registered tools out of the server source. Each tool is a
 * `this.server.registerTool(` call whose first argument (on the next line) is
 * the tool name; the phase is the enclosing `registerPhaseN[...]()` method.
 * "registerPhase11Part2" collapses to phase "11" (leading digits).
 */
function toolsFromSource(): Tool[] {
	const lines = readFileSync(join(root, "src/server.ts"), "utf8").split("\n");
	const phaseDecl = /private\s+registerPhase([A-Za-z0-9]+)\s*\(/;
	const nameLit = /^\s*"([a-z_][a-z0-9_]*)"\s*,/;

	let phase: string | null = null;
	const tools: Tool[] = [];
	for (let i = 0; i < lines.length; i++) {
		const decl = lines[i].match(phaseDecl);
		if (decl) {
			phase = decl[1].match(/^\d+/)?.[0] ?? decl[1];
			continue;
		}
		if (/\bregisterTool\(/.test(lines[i])) {
			for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
				const nm = lines[j].match(nameLit);
				if (nm) {
					tools.push({ name: nm[1], phase: phase ?? "?" });
					break;
				}
			}
		}
	}
	return tools;
}

/** Parse the README tool table rows between the TOOLS:START / TOOLS:END markers. */
function toolsFromReadme(): Tool[] {
	const readme = readFileSync(join(root, "README.md"), "utf8");
	const start = readme.indexOf("TOOLS:START");
	const end = readme.indexOf("TOOLS:END");
	if (start === -1 || end === -1 || end < start) {
		throw new Error("README is missing the TOOLS:START / TOOLS:END markers");
	}
	const block = readme.slice(start, end);
	const rowRe = /^\|\s*`([a-z_][a-z0-9_]*)`\s*\|\s*([A-Za-z0-9]+)\s*\|/gm;
	const tools: Tool[] = [];
	let m: RegExpExecArray | null;
	while ((m = rowRe.exec(block)) !== null) tools.push({ name: m[1], phase: m[2] });
	return tools;
}

describe("README tool table is in sync with src/server.ts", () => {
	const source = toolsFromSource();
	const readme = toolsFromReadme();

	it("the parsers find a plausible number of tools", () => {
		// Guards against a regex that silently matches nothing (which would make
		// every set comparison trivially pass).
		expect(source.length).toBeGreaterThan(20);
		expect(readme.length).toBeGreaterThan(20);
		expect(new Set(readme.map((t) => t.name)).size).toBe(readme.length); // no dup rows
	});

	it("every registered tool appears in the README table", () => {
		const documented = new Set(readme.map((t) => t.name));
		const missing = source.map((t) => t.name).filter((n) => !documented.has(n));
		expect(missing, `registered tools missing from the README "Tools" table`).toEqual([]);
	});

	it("every README table row is a registered tool", () => {
		const registered = new Set(source.map((t) => t.name));
		const orphans = readme.map((t) => t.name).filter((n) => !registered.has(n));
		expect(orphans, `README rows that are not registered tools (renamed/removed?)`).toEqual([]);
	});

	it("each tool's phase matches between the README and the source", () => {
		const sourcePhase = new Map(source.map((t) => [t.name, t.phase]));
		const mismatches = readme
			.filter((t) => sourcePhase.has(t.name) && sourcePhase.get(t.name) !== t.phase)
			.map((t) => `${t.name}: README says phase ${t.phase}, source is phase ${sourcePhase.get(t.name)}`);
		expect(mismatches).toEqual([]);
	});
});
