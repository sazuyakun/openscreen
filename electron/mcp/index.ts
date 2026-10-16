// In-app MCP server: lets Claude (or any MCP client) edit the project open in the editor.
// Serves Streamable HTTP on 127.0.0.1 only; each request gets a fresh stateless server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BrowserWindow } from "electron";
import type { PreviewRect } from "../../src/lib/mcpBridge";
import { EditorBridge } from "./bridge";
import { createMcpServer } from "./tools";

export const DEFAULT_MCP_PORT = 39251;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const PREVIEW_MAX_WIDTH = 1280;

interface McpSettings {
	enabled: boolean;
	port: number;
}

export interface McpController {
	readonly running: boolean;
	readonly enabled: boolean;
	readonly url: string;
	readonly error: string | null;
	setEnabled(enabled: boolean): Promise<void>;
	setupCommand(): string;
}

export function startMcpController(options: {
	userDataDir: string;
	recordingsDir: string;
	getEditorWindow: () => BrowserWindow | null;
	openEditorWindow: () => void;
	onStatusChange: () => void;
}): McpController {
	const settingsPath = path.join(options.userDataDir, "mcp-server.json");
	const settings = readSettings(settingsPath);
	const envPort = Number(process.env.OPENSCREEN_MCP_PORT);
	const port = Number.isInteger(envPort) && envPort > 0 ? envPort : settings.port;
	const bridge = new EditorBridge(options.getEditorWindow, options.openEditorWindow);
	const toolEnv = {
		bridge,
		recordingsDir: options.recordingsDir,
		historyDir: path.join(options.userDataDir, "mcp-history"),
		extraProjectDirs: (process.env.OPENSCREEN_PROJECT_DIRS ?? "")
			.split(path.delimiter)
			.map((dir) => dir.trim())
			.filter(Boolean),
		capturePreview: async (rect: PreviewRect) => {
			const win = bridge.readyWindow();
			if (!win) throw new Error("The OpenScreen editor isn't open");
			const image = await win.webContents.capturePage({
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.max(1, Math.round(rect.width)),
				height: Math.max(1, Math.round(rect.height)),
			});
			if (image.isEmpty())
				throw new Error("Couldn't capture the preview (is the editor window visible?)");
			const size = image.getSize();
			const scaled =
				size.width > PREVIEW_MAX_WIDTH ? image.resize({ width: PREVIEW_MAX_WIDTH }) : image;
			return scaled.toJPEG(85);
		},
	};

	let httpServer: http.Server | null = null;
	let lastError: string | null = null;
	const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
	const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

	async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
		// Block DNS rebinding and cross-site requests from web pages.
		const origin = req.headers.origin;
		if (!allowedHosts.has(req.headers.host ?? "") || (origin && !allowedOrigins.has(origin))) {
			res.writeHead(403).end("Forbidden");
			return;
		}
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		if (url.pathname !== "/mcp") {
			res.writeHead(404).end("Not found");
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
			return;
		}
		let body: unknown;
		try {
			body = JSON.parse(await readBody(req));
		} catch (error) {
			res.writeHead(400).end((error as Error).message);
			return;
		}
		const server = createMcpServer(toolEnv);
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
	}

	async function start() {
		if (httpServer) return;
		const serverInstance = http.createServer((req, res) => {
			handle(req, res).catch((error) => {
				console.error("[mcp] request failed:", error);
				if (!res.headersSent) res.writeHead(500).end("Internal error");
			});
		});
		await new Promise<void>((resolve) => {
			serverInstance.once("error", (error: NodeJS.ErrnoException) => {
				lastError =
					error.code === "EADDRINUSE"
						? `Port ${port} is already in use (another OpenScreen open?)`
						: error.message;
				console.error("[mcp] could not start:", lastError);
				resolve();
			});
			serverInstance.listen(port, "127.0.0.1", () => {
				httpServer = serverInstance;
				lastError = null;
				console.log(`[mcp] listening on http://127.0.0.1:${port}/mcp`);
				resolve();
			});
		});
		options.onStatusChange();
	}

	async function stop() {
		const current = httpServer;
		httpServer = null;
		if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
		options.onStatusChange();
	}

	if (settings.enabled && process.env.OPENSCREEN_MCP_DISABLED !== "1") void start();

	return {
		get running() {
			return httpServer !== null;
		},
		get enabled() {
			return settings.enabled;
		},
		get url() {
			return `http://127.0.0.1:${port}/mcp`;
		},
		get error() {
			return lastError;
		},
		async setEnabled(enabled: boolean) {
			settings.enabled = enabled;
			writeSettings(settingsPath, settings);
			if (enabled) await start();
			else await stop();
		},
		setupCommand() {
			return `claude mcp add --transport http --scope user openscreen http://127.0.0.1:${port}/mcp`;
		},
	};
}

function readSettings(file: string): McpSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
			port: Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : DEFAULT_MCP_PORT,
		};
	} catch {
		return { enabled: true, port: DEFAULT_MCP_PORT };
	}
}

function writeSettings(file: string, settings: McpSettings) {
	try {
		fs.writeFileSync(file, JSON.stringify(settings, null, 2), "utf-8");
	} catch (error) {
		console.error("[mcp] could not save settings:", error);
	}
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}
