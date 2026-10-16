import { randomUUID } from "node:crypto";
import { type BrowserWindow, ipcMain } from "electron";
import {
	MCP_BRIDGE_READY_CHANNEL,
	MCP_BRIDGE_REQUEST_CHANNEL,
	MCP_BRIDGE_RESPONSE_CHANNEL,
	type McpBridgeEnvelope,
	type McpBridgeRequest,
	type McpBridgeResponse,
} from "../../src/lib/mcpBridge";

const REQUEST_TIMEOUT_MS = 20_000;
const EDITOR_OPEN_TIMEOUT_MS = 30_000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** Request/response channel from the MCP server to the editor window's renderer. */
export class EditorBridge {
	private readonly ready = new Set<number>();
	private readonly pending = new Map<string, Pending>();

	constructor(
		private readonly getEditorWindow: () => BrowserWindow | null,
		private readonly openEditorWindow: () => void,
	) {
		ipcMain.on(MCP_BRIDGE_READY_CHANNEL, (event) => {
			const id = event.sender.id;
			this.ready.add(id);
			event.sender.once("destroyed", () => this.ready.delete(id));
		});
		ipcMain.on(MCP_BRIDGE_RESPONSE_CHANNEL, (_event, response: McpBridgeResponse) => {
			const pending = this.pending.get(response?.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(response.id);
			if (response.ok) pending.resolve(response.result);
			else pending.reject(new Error(response.error));
		});
	}

	/** The editor window, if it's open and its MCP bridge has finished loading. */
	readyWindow(): BrowserWindow | null {
		const win = this.getEditorWindow();
		if (!win || win.isDestroyed() || !this.ready.has(win.webContents.id)) return null;
		return win;
	}

	async ensureEditor(): Promise<BrowserWindow> {
		const existing = this.readyWindow();
		if (existing) return existing;
		if (!this.getEditorWindow()) this.openEditorWindow();
		const deadline = Date.now() + EDITOR_OPEN_TIMEOUT_MS;
		while (Date.now() < deadline) {
			const win = this.readyWindow();
			if (win) return win;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error("The OpenScreen editor didn't open in time");
	}

	async request<T>(request: McpBridgeRequest, win?: BrowserWindow): Promise<T> {
		const target = win ?? this.readyWindow();
		if (!target) throw new Error("The OpenScreen editor isn't open");
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`The editor didn't answer "${request.method}" in time`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			const envelope: McpBridgeEnvelope = { id, request };
			target.webContents.send(MCP_BRIDGE_REQUEST_CHANNEL, envelope);
		});
	}
}
