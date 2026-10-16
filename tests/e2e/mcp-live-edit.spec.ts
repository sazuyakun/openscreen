import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { _electron as electron, expect, test } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
const TEST_VIDEO = path.join(__dirname, "../fixtures/sample.webm");
const MCP_PORT = "39261";

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = (await client.callTool({ name, arguments: args })) as {
		content: Array<{ type: string; text?: string }>;
		isError?: boolean;
	};
	if (result.isError) throw new Error(result.content[0]?.text);
	return JSON.parse(result.content[0]?.text ?? "null");
}

test("MCP edits apply live in the open editor and undo with the editor's history", async () => {
	const app = await electron.launch({
		args: [MAIN_JS, "--no-sandbox", "--enable-unsafe-swiftshader"],
		env: {
			...process.env,
			HEADLESS: process.env["HEADLESS"] ?? "true",
			OPENSCREEN_MCP_PORT: MCP_PORT,
		},
	});
	let testVideo = "";
	const client = new Client({ name: "e2e", version: "0.0.0" });
	try {
		const hud = await app.firstWindow({ timeout: 60_000 });
		await hud.waitForLoadState("domcontentloaded");

		const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
		const recordingsDir = path.join(userData, "recordings");
		fs.mkdirSync(recordingsDir, { recursive: true });
		testVideo = path.join(recordingsDir, "mcp-e2e-sample.webm");
		fs.copyFileSync(TEST_VIDEO, testVideo);

		await hud.evaluate(
			(videoPath: string) => window.electronAPI.setCurrentVideoPath(videoPath),
			testVideo,
		);
		await hud
			.evaluate(() => window.electronAPI.switchToEditor())
			.catch(() => {
				// The HUD window closes as the editor opens.
			});
		const editor = await app.waitForEvent("window", {
			predicate: (w) => w.url().includes("windowType=editor"),
			timeout: 15_000,
		});
		await editor.waitForLoadState("domcontentloaded");
		await expect(editor.getByText("Loading video...")).not.toBeVisible({ timeout: 15_000 });

		await client.connect(
			new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`)),
		);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(
			expect.arrayContaining(["add_zoom", "preview_frame", "undo"]),
		);

		await expect
			.poll(async () => (await callJson(client, "editor_status")).duration, { timeout: 15_000 })
			.toBeGreaterThan(0);

		await callJson(client, "add_zoom", { start: 0.2, end: 1, x: 0.3, y: 0.4, scale: 2.5 });
		await callJson(client, "set_style", { padding: 10, border_radius: 16 });
		let project = await callJson(client, "get_project");
		expect(project.live).toBe(true);
		expect(project.unsaved_changes).toBe(true);
		expect(project.zooms).toHaveLength(1);
		expect(project.zooms[0]).toMatchObject({ scale: 2.5, x: 0.3, y: 0.4 });
		expect(project.style.borderRadius).toBe(16);

		// Undo is the editor's own history: one step reverts the style, the next the zoom.
		await callJson(client, "undo");
		project = await callJson(client, "get_project");
		expect(project.style.borderRadius).not.toBe(16);
		expect(project.zooms).toHaveLength(1);
		await callJson(client, "undo");
		expect((await callJson(client, "get_project")).zooms).toHaveLength(0);
	} finally {
		await client.close().catch(() => undefined);
		// The process may already be gone.
		await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
		if (!app.process().killed) app.process().kill("SIGKILL");
		if (testVideo && fs.existsSync(testVideo)) fs.unlinkSync(testVideo);
	}
});
