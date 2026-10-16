// Contract between the in-app MCP server (main process) and the editor window, which
// owns the live project state. The main process sends a request; the editor applies it
// through its own state and history, so MCP edits show up immediately and undo with Cmd+Z.
import type {
	EditorProjectData,
	ProjectEditorState,
} from "@/components/video-editor/projectPersistence";
import type { ProjectMedia } from "@/lib/recordingSession";

export const MCP_BRIDGE_REQUEST_CHANNEL = "mcp-bridge:request";
export const MCP_BRIDGE_RESPONSE_CHANNEL = "mcp-bridge:response";
export const MCP_BRIDGE_READY_CHANNEL = "mcp-bridge:ready";

export interface LiveEditorSnapshot {
	projectPath: string | null;
	/** Null while no recording or project is loaded. */
	media: ProjectMedia | null;
	editor: ProjectEditorState;
	durationMs: number;
	currentTimeMs: number;
	hasUnsavedChanges: boolean;
	video: { width: number; height: number } | null;
}

export type McpBridgeRequest =
	| { method: "getState" }
	| { method: "applyEditor"; editor: ProjectEditorState; label: string }
	| { method: "openProject"; path: string; force: boolean }
	| { method: "save" }
	| { method: "undo" }
	| { method: "redo" }
	| { method: "seek"; timeMs: number }
	/** Seeks (when timeMs is set), waits for the frame to render, and returns the preview's on-screen rect. */
	| { method: "previewRect"; timeMs?: number };

export interface McpBridgeEnvelope {
	id: string;
	request: McpBridgeRequest;
}

export type McpBridgeResponse =
	| { id: string; ok: true; result: unknown }
	| { id: string; ok: false; error: string };

export interface PreviewRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type { EditorProjectData };
