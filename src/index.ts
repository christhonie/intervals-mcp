#!/usr/bin/env node
/**
 * stdio entry point — for local development / debugging (Claude Desktop, Cursor,
 * MCP Inspector). The remote deployment uses http-server.ts instead.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IntervalsMcpServer } from "./server.js";
import { loadConfig } from "./config.js";

async function main() {
	const config = loadConfig();
	const mcp = new IntervalsMcpServer(config);
	const transport = new StdioServerTransport();
	await mcp.server.connect(transport);
	console.error("[intervals-mcp] server running on stdio");
}

process.on("uncaughtException", (err) => console.error("[intervals-mcp] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[intervals-mcp] unhandledRejection:", err));

main().catch((err) => {
	console.error("[intervals-mcp] fatal:", err);
	process.exit(1);
});
