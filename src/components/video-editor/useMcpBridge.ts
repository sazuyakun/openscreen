import { type RefObject, useEffect } from "react";
import type { LiveEditorSnapshot, McpBridgeRequest, PreviewRect } from "@/lib/mcpBridge";
import type { ProjectEditorState } from "./projectPersistence";

/** What the editor exposes to the in-app MCP server. Kept in a ref so it always sees the latest state. */
export interface McpBridgeHandlers {
	getSnapshot: () => LiveEditorSnapshot;
	applyEditor: (editor: ProjectEditorState, label: string) => void;
	openProject: (path: string, force: boolean) => Promise<void>;
	save: () => Promise<{ saved: boolean; path: string | null }>;
	undo: () => void;
	redo: () => void;
	seek: (timeMs: number) => Promise<void>;
	previewRect: (timeMs?: number) => Promise<PreviewRect>;
}

function dispatch(handlers: McpBridgeHandlers, request: McpBridgeRequest): unknown {
	switch (request.method) {
		case "getState":
			return handlers.getSnapshot();
		case "applyEditor":
			return handlers.applyEditor(request.editor, request.label);
		case "openProject":
			return handlers.openProject(request.path, request.force);
		case "save":
			return handlers.save();
		case "undo":
			return handlers.undo();
		case "redo":
			return handlers.redo();
		case "seek":
			return handlers.seek(request.timeMs);
		case "previewRect":
			return handlers.previewRect(request.timeMs);
	}
}

/**
 * Answers the main process's MCP requests and announces the editor as ready once
 * `ready` is true (after the initial project/recording has loaded).
 */
export function useMcpBridge(handlersRef: RefObject<McpBridgeHandlers | null>, ready: boolean) {
	useEffect(() => {
		const api = window.electronAPI;
		if (!api?.onMcpBridgeRequest) return;
		return api.onMcpBridgeRequest(async ({ id, request }) => {
			try {
				const handlers = handlersRef.current;
				if (!handlers) throw new Error("The editor is still loading");
				const result = await dispatch(handlers, request);
				api.sendMcpBridgeResponse({ id, ok: true, result: result ?? null });
			} catch (error) {
				api.sendMcpBridgeResponse({
					id,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}, [handlersRef]);

	useEffect(() => {
		if (ready) window.electronAPI?.notifyMcpBridgeReady?.();
	}, [ready]);
}
