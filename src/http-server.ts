#!/usr/bin/env node
/**
 * Streamable HTTP transport for the Intervals.icu MCP server.
 * Designed for remote deployment behind TLS (K8s ingress + cert-manager).
 *
 * Auth model: single-user. Intervals.icu API key + athlete id come from env
 * vars (see .env.sample). The /mcp endpoint is gated by OAuth 2.1 with PKCE,
 * implemented in-process via the MCP SDK auth router and a minimal single-client
 * provider (see oauth-provider.ts). claude.ai's custom-connector UI registers
 * the server with the pre-shared OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET, then
 * walks the standard authorize → token flow.
 *
 * Structure mirrors the fatsecret-mcp reference per the remote-mcp-wrap skill.
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { IntervalsMcpServer } from "./server.js";
import { loadConfig } from "./config.js";
import { MinimalOAuthProvider } from "./oauth-provider.js";
import { createOAuthStore } from "./oauth-store.js";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`[intervals-mcp] Missing required env var: ${name}`);
		process.exit(1);
	}
	return v;
}

// OAuth 2.1 client credentials registered with claude.ai.
const OAUTH_CLIENT_ID = requireEnv("OAUTH_CLIENT_ID");
const OAUTH_CLIENT_SECRET = requireEnv("OAUTH_CLIENT_SECRET");

// Default to the public deployment URL; override via env for local dev.
const ISSUER_URL = new URL(process.env.OAUTH_ISSUER_URL ?? "https://icu-mcp.christhonie.co.za");

// Pre-registered redirect URIs. Exact-match per OAuth 2.1.
const REDIRECT_URIS = (
	process.env.OAUTH_REDIRECT_URIS ??
	"https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,http://localhost:3000/callback"
)
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

// Fail fast on the Intervals.icu side too (loadConfig exits if the key is absent).
const config = loadConfig();

const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";

// OAuth state store: Redis when REDIS_URL is set (survives rollouts), else
// in-memory. The prefix isolates this server's keys in a shared Redis.
const oauthStore = createOAuthStore("intervals-mcp:oauth");

const provider = new MinimalOAuthProvider({
	clientId: OAUTH_CLIENT_ID,
	clientSecret: OAUTH_CLIENT_SECRET,
	redirectUris: REDIRECT_URIS,
	clientName: "Intervals.icu MCP",
	store: oauthStore,
});

const app = express();
app.disable("x-powered-by");
// Behind the nginx ingress, requests carry X-Forwarded-For. Trust the single
// proxy hop so the MCP SDK's rate limiters (mounted on the OAuth routes) read
// the real client IP instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Health probe (unauthenticated).
app.get("/healthz", (_req, res) => {
	res.status(200).json({ status: "ok" });
});

// OAuth 2.1 server endpoints: /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /revoke.
app.use(
	mcpAuthRouter({
		provider,
		issuerUrl: ISSUER_URL,
		baseUrl: ISSUER_URL,
		resourceName: "Intervals.icu MCP",
	}),
);

const requireBearer = requireBearerAuth({
	verifier: provider,
	resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource", ISSUER_URL).toString(),
});

// One transport (and one IntervalsMcpServer) per MCP session.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", requireBearer, async (req, res) => {
	const sid = req.header("mcp-session-id");
	let transport = sid ? transports.get(sid) : undefined;

	if (!transport) {
		if (sid) {
			res.status(404).json({
				jsonrpc: "2.0",
				error: { code: -32004, message: "Unknown session" },
				id: null,
			});
			return;
		}
		if (!isInitializeRequest(req.body)) {
			res.status(400).json({
				jsonrpc: "2.0",
				error: { code: -32003, message: "First request must be initialize" },
				id: null,
			});
			return;
		}

		const newTransport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				transports.set(id, newTransport);
				console.error(`[intervals-mcp] session opened: ${id}`);
			},
		});
		newTransport.onclose = () => {
			if (newTransport.sessionId) {
				transports.delete(newTransport.sessionId);
				console.error(`[intervals-mcp] session closed: ${newTransport.sessionId}`);
			}
		};

		const mcp = new IntervalsMcpServer(config);
		await mcp.server.connect(newTransport);
		transport = newTransport;
	}

	await transport.handleRequest(req, res, req.body);
});

const handleSessionGetDelete = async (req: Request, res: Response) => {
	const sid = req.header("mcp-session-id");
	const transport = sid ? transports.get(sid) : undefined;
	if (!transport) {
		res.status(400).send("Missing or unknown Mcp-Session-Id");
		return;
	}
	await transport.handleRequest(req, res);
};

app.get("/mcp", requireBearer, handleSessionGetDelete);
app.delete("/mcp", requireBearer, handleSessionGetDelete);

const server = app.listen(PORT, HOST, () => {
	console.error(`[intervals-mcp] Streamable HTTP listening on http://${HOST}:${PORT}`);
	console.error(`[intervals-mcp] OAuth issuer: ${ISSUER_URL.toString()}`);
	console.error(`[intervals-mcp] Pre-registered redirect URIs: ${REDIRECT_URIS.join(", ")}`);
});

const shutdown = (signal: string) => {
	console.error(`[intervals-mcp] ${signal} received, draining…`);
	server.close(() => process.exit(0));
	for (const t of transports.values()) t.close();
	setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => console.error("[intervals-mcp] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[intervals-mcp] unhandledRejection:", err));
