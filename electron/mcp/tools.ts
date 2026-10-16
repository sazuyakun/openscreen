import { existsSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	deriveNextId,
	type EditorProjectData,
	PROJECT_VERSION,
	type ProjectEditorState,
} from "../../src/components/video-editor/projectPersistence";
import {
	type AnnotationRegion,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_DATA,
	DEFAULT_FIGURE_DATA,
	DEFAULT_ZOOM_DEPTH,
	MAX_PLAYBACK_SPEED,
	MAX_ZOOM_SCALE,
	MIN_PLAYBACK_SPEED,
	MIN_ZOOM_SCALE,
	type SpeedRegion,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomRegion,
} from "../../src/components/video-editor/types";
import type { LiveEditorSnapshot, PreviewRect } from "../../src/lib/mcpBridge";
import { WALLPAPER_COUNT } from "../../src/lib/wallpaper";
import { ASPECT_RATIOS } from "../../src/utils/aspectRatioUtils";
import type { EditorBridge } from "./bridge";
import { ARROW_DIRECTIONS, STYLE_KEYS, TEXT_ANIMATIONS } from "./constants";
import { loadCursorSamples } from "./cursor";
import { detectFrozenScreen, detectSilence, extractFrame, hasFfmpeg, probeVideo } from "./media";
import {
	createProjectFile,
	expandHome,
	getScreenVideoPath,
	listProjectFiles,
	readProjectFile,
	resolveProjectPath,
	undoProjectFile,
	writeProjectFile,
} from "./projectFiles";
import {
	clamp,
	cursorIdleSpans,
	intersectSpans,
	isClick,
	mergeSpans,
	outputDurationMs,
	overlaps,
	planClickZooms,
	planDwellZooms,
	type Span,
	shrinkSpans,
	subtractSpans,
	videoRectToCanvasPercent,
} from "./timeline";

export interface ToolEnv {
	bridge: EditorBridge;
	recordingsDir: string;
	historyDir: string;
	extraProjectDirs: string[];
	capturePreview: (rect: PreviewRect) => Promise<Buffer>;
}

const INSTRUCTIONS = `Edits OpenScreen screen recordings. Runs inside the OpenScreen app.
- Tools act on the project open in the editor when you leave out "project": changes appear instantly, and the user can undo each one with Cmd+Z. Pass a .openscreen path to edit a project that isn't open; if that path is the open project, the live editor is used.
- Times are seconds of the original recording. Positions are fractions (0-1) of the video frame unless a tool says otherwise.
- Look before you edit: get_project for the timeline, get_cursor_activity for clicks and pauses, get_frame for the raw recording and preview_frame for what the edited video looks like.
- Edits to the open project aren't written to disk until save_project (or the user saves).`;

const sec = (ms: number) => Math.round(ms) / 1000;
const ms = (seconds: number) => Math.round(seconds * 1000);

function reply(payload: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

interface Target {
	live: boolean;
	/** Project file path; null for a live recording that was never saved. */
	path: string | null;
	data: EditorProjectData;
	editor: ProjectEditorState;
	videoPath: string;
	/** Recording length in ms; null when unknown (no FFmpeg, no telemetry). */
	totalMs: number | null;
	videoSize: { width: number; height: number } | null;
	hasUnsavedChanges?: boolean;
}

function zoomScale(zoom: ZoomRegion): number {
	return zoom.customScale ?? ZOOM_DEPTH_SCALES[zoom.depth] ?? ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH];
}

/** Closest depth preset to a scale, so the app's depth buttons still look right. */
function depthForScale(scale: number): ZoomDepth {
	let best: ZoomDepth = DEFAULT_ZOOM_DEPTH;
	for (const [depth, value] of Object.entries(ZOOM_DEPTH_SCALES)) {
		if (Math.abs(value - scale) < Math.abs(ZOOM_DEPTH_SCALES[best] - scale)) {
			best = Number(depth) as ZoomDepth;
		}
	}
	return best;
}

function describeZoom(zoom: ZoomRegion) {
	return {
		id: zoom.id,
		start: sec(zoom.startMs),
		end: sec(zoom.endMs),
		scale: zoomScale(zoom),
		x: Number(zoom.focus.cx.toFixed(4)),
		y: Number(zoom.focus.cy.toFixed(4)),
		...(zoom.focusMode === "auto" ? { follow_cursor: true } : {}),
		...(zoom.rotationPreset ? { rotation: zoom.rotationPreset } : {}),
		source: zoom.source ?? "manual",
	};
}

function describeAnnotation(annotation: AnnotationRegion) {
	return {
		id: annotation.id,
		type: annotation.type === "figure" ? "arrow" : annotation.type,
		start: sec(annotation.startMs),
		end: sec(annotation.endMs),
		...(annotation.type === "text" ? { text: annotation.textContent ?? annotation.content } : {}),
		...(annotation.type === "figure" && annotation.figureData
			? { direction: annotation.figureData.arrowDirection }
			: {}),
		canvas_rect: {
			x: Number((annotation.position.x / 100).toFixed(4)),
			y: Number((annotation.position.y / 100).toFixed(4)),
			width: Number((annotation.size.width / 100).toFixed(4)),
			height: Number((annotation.size.height / 100).toFixed(4)),
		},
	};
}

function describeStyle(editor: ProjectEditorState) {
	return Object.fromEntries(
		[...STYLE_KEYS, "cropRegion" as const].map((key) => [key, editor[key]]),
	);
}

function findOverlap<T extends { id: string; startMs: number; endMs: number }>(
	regions: T[],
	span: Span,
	ignoreId?: string,
): T | undefined {
	return regions.find(
		(region) =>
			region.id !== ignoreId && overlaps(span, { start: region.startMs, end: region.endMs }),
	);
}

/** Trims overlapping or touching the new span are folded into it. */
function addTrimMerged(editor: ProjectEditorState, span: Span) {
	const touching = editor.trimRegions.filter((t) => t.startMs <= span.end && span.start <= t.endMs);
	const merged = mergeSpans([
		span,
		...touching.map((t) => ({ start: t.startMs, end: t.endMs })),
	])[0];
	const id = `trim-${deriveNextId(
		"trim",
		editor.trimRegions.map((t) => t.id),
	)}`;
	editor.trimRegions = editor.trimRegions.filter((t) => !touching.includes(t));
	editor.trimRegions.push({ id, startMs: merged.start, endMs: merged.end });
	return {
		id,
		start: sec(merged.start),
		end: sec(merged.end),
		absorbed: touching.map((t) => t.id),
	};
}

function nextId(prefix: string, regions: Array<{ id: string }>): string {
	return `${prefix}-${deriveNextId(
		prefix,
		regions.map((r) => r.id),
	)}`;
}

const projectArg = z
	.string()
	.optional()
	.describe("Path to a .openscreen file. Leave out to edit the project open in the editor.");
const fraction = z.number().min(0).max(1);

export function createMcpServer(env: ToolEnv): McpServer {
	const { bridge } = env;
	const server = new McpServer(
		{ name: "openscreen", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);

	async function liveSnapshot(): Promise<LiveEditorSnapshot | null> {
		if (!bridge.readyWindow()) return null;
		return bridge.request<LiveEditorSnapshot>({ method: "getState" });
	}

	async function openTarget(project?: string): Promise<Target> {
		const snapshot = await liveSnapshot();
		const projectPath = project ? resolveProjectPath(project) : null;
		const isOpenProject =
			snapshot?.media &&
			(!projectPath ||
				(snapshot.projectPath && path.resolve(snapshot.projectPath) === projectPath));

		if (snapshot?.media && isOpenProject) {
			const videoPath = snapshot.media.screenVideoPath;
			let totalMs = snapshot.durationMs > 0 ? snapshot.durationMs : null;
			let videoSize = snapshot.video;
			if ((totalMs === null || !videoSize) && existsSync(videoPath) && hasFfmpeg()) {
				const info = await probeVideo(videoPath).catch(() => null);
				totalMs ??= info?.durationMs ?? null;
				videoSize ??= info ? { width: info.width, height: info.height } : null;
			}
			const data: EditorProjectData = {
				version: PROJECT_VERSION,
				media: snapshot.media,
				editor: structuredClone(snapshot.editor),
			};
			return {
				live: true,
				path: snapshot.projectPath,
				data,
				editor: data.editor,
				videoPath,
				totalMs,
				videoSize,
				hasUnsavedChanges: snapshot.hasUnsavedChanges,
			};
		}
		if (!projectPath) {
			throw new Error(
				"No project is open in the OpenScreen editor. Pass a .openscreen path, or call open_project first.",
			);
		}

		const { path: filePath, data } = await readProjectFile(projectPath);
		const videoPath = getScreenVideoPath(data);
		let totalMs: number | null = null;
		let videoSize: Target["videoSize"] = null;
		if (existsSync(videoPath) && hasFfmpeg()) {
			const info = await probeVideo(videoPath).catch(() => null);
			totalMs = info?.durationMs ?? null;
			videoSize = info ? { width: info.width, height: info.height } : null;
		}
		if (totalMs === null) {
			const samples = await loadCursorSamples(videoPath).catch(() => []);
			totalMs = samples.at(-1)?.timeMs ?? null;
		}
		return {
			live: false,
			path: filePath,
			data,
			editor: data.editor,
			videoPath,
			totalMs,
			videoSize,
		};
	}

	async function commit(target: Target, label: string, summary: Record<string, unknown>) {
		if (target.live) {
			await bridge.request({ method: "applyEditor", editor: target.editor, label });
		} else if (target.path) {
			await writeProjectFile(env.historyDir, target.path, target.data);
		}
		return reply({
			...summary,
			project: target.path,
			live: target.live,
			output_duration:
				target.totalMs === null
					? null
					: sec(
							outputDurationMs(
								target.totalMs,
								target.editor.trimRegions,
								target.editor.speedRegions,
							),
						),
			...(target.live
				? { note: "Applied in the editor. Cmd+Z undoes it; save_project writes it to disk." }
				: { note: "Saved to the file." }),
		});
	}

	function toSpan(target: Target, startSec: number, endSec: number): Span {
		if (!(endSec > startSec))
			throw new Error(`end (${endSec}s) must be after start (${startSec}s)`);
		const start = ms(startSec);
		const end = target.totalMs === null ? ms(endSec) : Math.min(ms(endSec), target.totalMs);
		if (end <= start) {
			throw new Error(
				`start (${startSec}s) is past the end of the recording (${sec(target.totalMs ?? 0)}s)`,
			);
		}
		return { start, end };
	}

	function requireDuration(target: Target): number {
		if (target.totalMs === null) {
			throw new Error(
				"Can't determine the recording length. Install FFmpeg (brew install ffmpeg).",
			);
		}
		return target.totalMs;
	}

	async function describe(target: Target) {
		const { editor } = target;
		const samples = existsSync(target.videoPath) ? await loadCursorSamples(target.videoPath) : [];
		return {
			project: target.path,
			live: target.live,
			...(target.live ? { unsaved_changes: target.hasUnsavedChanges ?? false } : {}),
			video: target.videoPath,
			video_missing: !existsSync(target.videoPath),
			...(target.data.media?.webcamVideoPath
				? { webcam_video: target.data.media.webcamVideoPath }
				: {}),
			duration: target.totalMs === null ? null : sec(target.totalMs),
			output_duration:
				target.totalMs === null
					? null
					: sec(outputDurationMs(target.totalMs, editor.trimRegions, editor.speedRegions)),
			...(target.videoSize
				? { resolution: `${target.videoSize.width}x${target.videoSize.height}` }
				: {}),
			cursor_telemetry: { samples: samples.length, clicks: samples.filter(isClick).length },
			zooms: [...editor.zoomRegions].sort((a, b) => a.startMs - b.startMs).map(describeZoom),
			trims: [...editor.trimRegions]
				.sort((a, b) => a.startMs - b.startMs)
				.map((t) => ({ id: t.id, start: sec(t.startMs), end: sec(t.endMs) })),
			speed_changes: [...editor.speedRegions]
				.sort((a, b) => a.startMs - b.startMs)
				.map((s) => ({ id: s.id, start: sec(s.startMs), end: sec(s.endMs), speed: s.speed })),
			annotations: [...editor.annotationRegions]
				.sort((a, b) => a.startMs - b.startMs)
				.map(describeAnnotation),
			style: describeStyle(editor),
		};
	}

	server.registerTool(
		"editor_status",
		{
			title: "Editor status",
			description:
				"Whether the OpenScreen editor is open, which project it shows, unsaved changes and the playhead time.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () => {
			const snapshot = await liveSnapshot();
			if (!snapshot) return reply({ editor_open: false });
			return reply({
				editor_open: true,
				project: snapshot.projectPath,
				video: snapshot.media?.screenVideoPath ?? null,
				unsaved_changes: snapshot.hasUnsavedChanges,
				duration: sec(snapshot.durationMs),
				playhead: sec(snapshot.currentTimeMs),
			});
		},
	);

	server.registerTool(
		"list_projects",
		{
			title: "List projects",
			description:
				"Lists OpenScreen projects (.openscreen) and recordings without a project yet, newest first, from the recordings folder (plus OPENSCREEN_PROJECT_DIRS).",
			inputSchema: { directory: z.string().optional().describe("Search only this folder instead") },
			annotations: { readOnlyHint: true },
		},
		async ({ directory }) => {
			const dirs = directory
				? [expandHome(directory)]
				: [env.recordingsDir, ...env.extraProjectDirs];
			return reply({ searched: dirs, ...(await listProjectFiles(dirs)) });
		},
	);

	server.registerTool(
		"open_project",
		{
			title: "Open project",
			description:
				"Opens a .openscreen project in the editor so later edits apply live. Refuses if the editor has unsaved changes unless discard_unsaved is true.",
			inputSchema: {
				project: z.string().describe("Path to the .openscreen file"),
				discard_unsaved: z.boolean().default(false),
			},
		},
		async ({ project, discard_unsaved }) => {
			const projectPath = resolveProjectPath(project);
			const win = await bridge.ensureEditor();
			await bridge.request(
				{ method: "openProject", path: projectPath, force: discard_unsaved },
				win,
			);
			return reply({ opened: projectPath, ...(await describe(await openTarget())) });
		},
	);

	server.registerTool(
		"create_project",
		{
			title: "Create project",
			description:
				"Creates a .openscreen project file for a recording (next to the video by default), optionally copying another project's style. Use open_project afterwards to edit it live.",
			inputSchema: {
				video: z.string().describe("Path to the recorded video"),
				project: z.string().optional().describe("Where to save the project"),
				style_from: z.string().optional().describe("Existing project to copy the style from"),
				overwrite: z.boolean().optional(),
			},
		},
		async ({ video, project, style_from, overwrite }) => {
			let editor: Partial<ProjectEditorState> | undefined;
			if (style_from) {
				const source = await readProjectFile(style_from);
				editor = Object.fromEntries(STYLE_KEYS.map((key) => [key, source.data.editor[key]]));
			}
			const created = await createProjectFile({
				historyRoot: env.historyDir,
				videoPath: video,
				projectPath: project,
				overwrite,
				editor,
			});
			return reply({ created: created.path, ...(await describe(await openTarget(created.path))) });
		},
	);

	server.registerTool(
		"save_project",
		{
			title: "Save project",
			description:
				"Saves the project open in the editor to its .openscreen file, like Cmd+S. A recording that was never saved shows the Save dialog to the user.",
			inputSchema: {},
		},
		async () => {
			if (!bridge.readyWindow()) throw new Error("The OpenScreen editor isn't open");
			const result = await bridge.request<{ saved: boolean; path: string | null }>({
				method: "save",
			});
			return reply(result);
		},
	);

	server.registerTool(
		"get_project",
		{
			title: "Get project",
			description:
				"Shows the timeline (zooms, cuts, speed changes, annotations with ids), style settings, recording length and length after edits.",
			inputSchema: { project: projectArg },
			annotations: { readOnlyHint: true },
		},
		async ({ project }) => reply(await describe(await openTarget(project))),
	);

	server.registerTool(
		"get_cursor_activity",
		{
			title: "Get cursor activity",
			description:
				"Clicks (time and position) and stretches where the cursor sat still, from the cursor telemetry OpenScreen records.",
			inputSchema: {
				project: projectArg,
				start: z.number().min(0).optional().describe("Only from this time (s)"),
				end: z.number().min(0).optional().describe("Only up to this time (s)"),
				idle_min_seconds: z
					.number()
					.min(0.5)
					.default(2)
					.describe("Shortest still stretch to report"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ project, start, end, idle_min_seconds }) => {
			const target = await openTarget(project);
			const samples = await loadCursorSamples(target.videoPath);
			if (samples.length === 0)
				return reply({ project: target.path, note: "No cursor telemetry for this recording." });
			const total = target.totalMs ?? samples[samples.length - 1].timeMs;
			const from = start === undefined ? 0 : ms(start);
			const to = end === undefined ? total : ms(end);
			const clicks = samples
				.filter((s) => isClick(s) && s.timeMs >= from && s.timeMs <= to)
				.map((s) => ({
					time: sec(s.timeMs),
					x: Number(s.cx.toFixed(4)),
					y: Number(s.cy.toFixed(4)),
					type: s.interactionType,
				}));
			const idle = cursorIdleSpans(samples, total, ms(idle_min_seconds))
				.filter((s) => s.end > from && s.start < to)
				.map((s) => ({ start: sec(s.start), end: sec(s.end), seconds: sec(s.end - s.start) }));
			return reply({
				project: target.path,
				duration: sec(total),
				clicks: clicks.slice(0, 500),
				...(clicks.length > 500 ? { clicks_truncated: clicks.length } : {}),
				cursor_still: idle,
			});
		},
	);

	server.registerTool(
		"get_frame",
		{
			title: "Get frame",
			description:
				"A still of the raw recording at a time, to see what's on screen before placing zooms, arrows, labels or blur. x/y fractions in other tools map to this image's width/height.",
			inputSchema: {
				project: projectArg,
				video: z.string().optional().describe("Video path instead of a project"),
				time: z.number().min(0).describe("Seconds into the recording"),
				max_width: z.number().int().min(160).max(3840).default(1280),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ project, video, time, max_width }) => {
			const videoPath = video ? expandHome(video) : (await openTarget(project)).videoPath;
			const image = await extractFrame(videoPath, ms(time), max_width);
			return {
				content: [
					{ type: "text" as const, text: `Recording frame at ${time}s` },
					{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" },
				],
			};
		},
	);

	server.registerTool(
		"preview_frame",
		{
			title: "Preview frame",
			description:
				"A screenshot of the editor's preview at a time: the edited look with wallpaper, zoom, cursor and annotations. Only for the project open in the editor. Moves the playhead.",
			inputSchema: {
				time: z.number().min(0).optional().describe("Seconds; leave out for the current playhead"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ time }) => {
			if (!bridge.readyWindow()) throw new Error("The OpenScreen editor isn't open");
			const rect = await bridge.request<PreviewRect>({
				method: "previewRect",
				...(time === undefined ? {} : { timeMs: ms(time) }),
			});
			const image = await env.capturePreview(rect);
			return {
				content: [
					{
						type: "text" as const,
						text: time === undefined ? "Editor preview" : `Editor preview at ${time}s`,
					},
					{ type: "image" as const, data: image.toString("base64"), mimeType: "image/jpeg" },
				],
			};
		},
	);

	server.registerTool(
		"seek",
		{
			title: "Move playhead",
			description: "Moves the editor's playhead, e.g. to show the user a change.",
			inputSchema: { time: z.number().min(0).describe("Seconds") },
		},
		async ({ time }) => {
			if (!bridge.readyWindow()) throw new Error("The OpenScreen editor isn't open");
			await bridge.request({ method: "seek", timeMs: ms(time) });
			return reply({ playhead: time });
		},
	);

	server.registerTool(
		"add_zoom",
		{
			title: "Add zoom",
			description: "Zooms in on a point of the recording between two times. Zooms can't overlap.",
			inputSchema: {
				project: projectArg,
				start: z.number().min(0).describe("Seconds"),
				end: z.number().min(0).describe("Seconds"),
				x: fraction.default(0.5).describe("Focus point, fraction of video width"),
				y: fraction.default(0.5).describe("Focus point, fraction of video height"),
				scale: z
					.number()
					.min(MIN_ZOOM_SCALE)
					.max(MAX_ZOOM_SCALE)
					.default(1.8)
					.describe("Magnification, 1-5"),
				follow_cursor: z
					.boolean()
					.default(false)
					.describe("Follow the cursor instead of a fixed point"),
				rotation: z
					.enum(["none", "iso", "left", "right"])
					.default("none")
					.describe("3D tilt preset"),
			},
		},
		async ({ project, start, end, x, y, scale, follow_cursor, rotation }) => {
			const target = await openTarget(project);
			const span = toSpan(target, start, end);
			const clash = findOverlap(target.editor.zoomRegions, span);
			if (clash) {
				throw new Error(
					`Overlaps zoom ${clash.id} (${sec(clash.startMs)}-${sec(clash.endMs)}s). Move or remove it first.`,
				);
			}
			const zoom: ZoomRegion = {
				id: nextId("zoom", target.editor.zoomRegions),
				startMs: span.start,
				endMs: span.end,
				depth: depthForScale(scale),
				customScale: Math.round(scale * 100) / 100,
				focus: { cx: x, cy: y },
				focusMode: follow_cursor ? "auto" : "manual",
				...(rotation !== "none" ? { rotationPreset: rotation } : {}),
				source: "manual",
			};
			target.editor.zoomRegions.push(zoom);
			return commit(target, "added a zoom", { added: describeZoom(zoom) });
		},
	);

	server.registerTool(
		"add_trim",
		{
			title: "Cut a section",
			description: "Cuts a section out of the exported video. Overlapping cuts are merged.",
			inputSchema: {
				project: projectArg,
				start: z.number().min(0).describe("Seconds"),
				end: z.number().min(0).describe("Seconds"),
			},
		},
		async ({ project, start, end }) => {
			const target = await openTarget(project);
			const added = addTrimMerged(target.editor, toSpan(target, start, end));
			return commit(target, "cut a section", { added });
		},
	);

	server.registerTool(
		"add_speed",
		{
			title: "Change speed",
			description:
				"Speeds up or slows down a section (2 = twice as fast). Speed changes can't overlap.",
			inputSchema: {
				project: projectArg,
				start: z.number().min(0).describe("Seconds"),
				end: z.number().min(0).describe("Seconds"),
				speed: z
					.number()
					.min(MIN_PLAYBACK_SPEED)
					.max(MAX_PLAYBACK_SPEED)
					.describe("Playback rate, 0.1-16"),
			},
		},
		async ({ project, start, end, speed }) => {
			const target = await openTarget(project);
			const span = toSpan(target, start, end);
			const clash = findOverlap(target.editor.speedRegions, span);
			if (clash) {
				throw new Error(
					`Overlaps speed change ${clash.id} (${sec(clash.startMs)}-${sec(clash.endMs)}s). Remove or update it first.`,
				);
			}
			const region: SpeedRegion = {
				id: nextId("speed", target.editor.speedRegions),
				startMs: span.start,
				endMs: span.end,
				speed: Math.round(speed * 100) / 100,
			};
			target.editor.speedRegions.push(region);
			return commit(target, `set ${region.speed}x speed`, {
				added: { id: region.id, start: sec(span.start), end: sec(span.end), speed: region.speed },
			});
		},
	);

	server.registerTool(
		"add_annotation",
		{
			title: "Add annotation",
			description:
				"Adds a text label, an arrow or a blur box for a time range. x/y is the top-left corner; width/height are fractions. relative_to 'video' (default) uses fractions of the recorded frame (what get_frame shows); 'canvas' uses the whole exported frame including the background. Annotations don't move with zooms.",
			inputSchema: {
				project: projectArg,
				type: z.enum(["text", "arrow", "blur"]),
				start: z.number().min(0).describe("Seconds"),
				end: z.number().min(0).describe("Seconds"),
				x: fraction.describe("Left edge"),
				y: fraction.describe("Top edge"),
				width: z.number().min(0.01).max(2).optional(),
				height: z.number().min(0.01).max(2).optional(),
				relative_to: z.enum(["video", "canvas"]).default("video"),
				text: z.string().optional().describe("Label text (type text)"),
				color: z.string().optional().describe("Text or arrow colour, e.g. #ffffff"),
				background_color: z
					.string()
					.optional()
					.describe("Text background, e.g. #000000cc or transparent"),
				font_size: z.number().min(8).max(200).optional().describe("Pixels"),
				font_family: z.string().optional(),
				bold: z.boolean().optional(),
				italic: z.boolean().optional(),
				align: z.enum(["left", "center", "right"]).optional(),
				animation: z.enum(TEXT_ANIMATIONS).optional(),
				direction: z.enum(ARROW_DIRECTIONS).optional().describe("Arrow direction (type arrow)"),
				stroke_width: z.number().min(1).max(20).optional().describe("Arrow thickness"),
				blur_style: z.enum(["blur", "mosaic"]).optional(),
				blur_shape: z.enum(["rectangle", "oval"]).optional(),
				blur_intensity: z.number().min(2).max(40).optional(),
			},
		},
		async (args) => {
			const target = await openTarget(args.project);
			const span = toSpan(target, args.start, args.end);
			if (args.type === "text" && !args.text)
				throw new Error("text is required for a text annotation");
			const defaults =
				args.type === "arrow" ? { width: 0.1, height: 0.1 } : { width: 0.3, height: 0.2 };
			let rect = {
				x: args.x,
				y: args.y,
				width: args.width ?? defaults.width,
				height: args.height ?? defaults.height,
			};
			if (args.relative_to === "video") {
				if (!target.videoSize) throw new Error("Video size unknown. Use relative_to: 'canvas'.");
				rect = videoRectToCanvasPercent(rect, target.videoSize, target.editor);
			} else {
				rect = {
					x: rect.x * 100,
					y: rect.y * 100,
					width: rect.width * 100,
					height: rect.height * 100,
				};
			}

			const regions = target.editor.annotationRegions;
			const annotation: AnnotationRegion = {
				id: nextId("annotation", regions),
				startMs: span.start,
				endMs: span.end,
				type: args.type === "arrow" ? "figure" : args.type,
				content: args.type === "text" ? (args.text ?? "") : "",
				...(args.type === "text" ? { textContent: args.text } : {}),
				position: { x: clamp(rect.x, 0, 100), y: clamp(rect.y, 0, 100) },
				size: { width: clamp(rect.width, 1, 200), height: clamp(rect.height, 1, 200) },
				style: {
					...DEFAULT_ANNOTATION_STYLE,
					...(args.color ? { color: args.color } : {}),
					...(args.background_color ? { backgroundColor: args.background_color } : {}),
					...(args.font_size ? { fontSize: args.font_size } : {}),
					...(args.font_family ? { fontFamily: args.font_family } : {}),
					...(args.bold !== undefined ? { fontWeight: args.bold ? "bold" : "normal" } : {}),
					...(args.italic !== undefined ? { fontStyle: args.italic ? "italic" : "normal" } : {}),
					...(args.align ? { textAlign: args.align } : {}),
					...(args.animation ? { textAnimation: args.animation } : {}),
				},
				zIndex: regions.reduce((max, r) => Math.max(max, r.zIndex ?? 0), 0) + 1,
				...(args.type === "arrow"
					? {
							figureData: {
								...DEFAULT_FIGURE_DATA,
								...(args.direction ? { arrowDirection: args.direction } : {}),
								...(args.color ? { color: args.color } : {}),
								...(args.stroke_width ? { strokeWidth: args.stroke_width } : {}),
							},
						}
					: {}),
				...(args.type === "blur"
					? {
							blurData: {
								...DEFAULT_BLUR_DATA,
								...(args.blur_style ? { type: args.blur_style } : {}),
								...(args.blur_shape ? { shape: args.blur_shape } : {}),
								...(args.blur_intensity ? { intensity: args.blur_intensity } : {}),
							},
						}
					: {}),
			};
			regions.push(annotation);
			return commit(target, `added ${args.type === "text" ? "a label" : `a ${args.type}`}`, {
				added: describeAnnotation(annotation),
			});
		},
	);

	server.registerTool(
		"update_region",
		{
			title: "Update region",
			description:
				"Changes a zoom, cut, speed change or annotation by id (from get_project). Only fields you pass change. For annotations x/y/width/height are fractions of the canvas.",
			inputSchema: {
				project: projectArg,
				id: z.string(),
				start: z.number().min(0).optional(),
				end: z.number().min(0).optional(),
				x: fraction.optional().describe("Zoom focus or annotation left edge"),
				y: fraction.optional().describe("Zoom focus or annotation top edge"),
				width: z.number().min(0.01).max(2).optional().describe("Annotation only"),
				height: z.number().min(0.01).max(2).optional().describe("Annotation only"),
				scale: z.number().min(MIN_ZOOM_SCALE).max(MAX_ZOOM_SCALE).optional().describe("Zoom only"),
				speed: z
					.number()
					.min(MIN_PLAYBACK_SPEED)
					.max(MAX_PLAYBACK_SPEED)
					.optional()
					.describe("Speed change only"),
				text: z.string().optional().describe("Text annotation only"),
			},
		},
		async (args) => {
			const target = await openTarget(args.project);
			const { editor } = target;
			const lists = {
				zoom: editor.zoomRegions,
				trim: editor.trimRegions,
				speed: editor.speedRegions,
				annotation: editor.annotationRegions,
			} as const;
			const kind = (Object.keys(lists) as Array<keyof typeof lists>).find((k) =>
				(lists[k] as Array<{ id: string }>).some((r) => r.id === args.id),
			);
			if (!kind) throw new Error(`No region with id ${args.id}`);
			const region = (lists[kind] as Array<{ id: string; startMs: number; endMs: number }>).find(
				(r) => r.id === args.id,
			) as { id: string; startMs: number; endMs: number };

			if (args.start !== undefined || args.end !== undefined) {
				const span = toSpan(
					target,
					args.start ?? sec(region.startMs),
					args.end ?? sec(region.endMs),
				);
				if (kind === "zoom" || kind === "speed") {
					const clash = findOverlap(lists[kind] as Array<typeof region>, span, region.id);
					if (clash)
						throw new Error(
							`Would overlap ${clash.id} (${sec(clash.startMs)}-${sec(clash.endMs)}s)`,
						);
				}
				region.startMs = span.start;
				region.endMs = span.end;
			}
			if (kind === "zoom") {
				const zoom = region as ZoomRegion;
				if (args.x !== undefined) zoom.focus.cx = args.x;
				if (args.y !== undefined) zoom.focus.cy = args.y;
				if (args.scale !== undefined) {
					zoom.customScale = Math.round(args.scale * 100) / 100;
					zoom.depth = depthForScale(args.scale);
				}
				// Matches the app: an edited auto zoom becomes manual so the magic wand keeps it.
				zoom.source = "manual";
			}
			if (kind === "speed" && args.speed !== undefined) {
				(region as SpeedRegion).speed = Math.round(args.speed * 100) / 100;
			}
			if (kind === "annotation") {
				const annotation = region as AnnotationRegion;
				if (args.x !== undefined) annotation.position.x = args.x * 100;
				if (args.y !== undefined) annotation.position.y = args.y * 100;
				if (args.width !== undefined) annotation.size.width = clamp(args.width * 100, 1, 200);
				if (args.height !== undefined) annotation.size.height = clamp(args.height * 100, 1, 200);
				if (args.text !== undefined) {
					if (annotation.type !== "text")
						throw new Error(`${annotation.id} is not a text annotation`);
					annotation.content = args.text;
					annotation.textContent = args.text;
				}
			}
			return commit(target, `updated ${args.id}`, { updated: args.id });
		},
	);

	server.registerTool(
		"remove_regions",
		{
			title: "Remove regions",
			description: "Removes zooms, cuts, speed changes or annotations, by id or all of one kind.",
			inputSchema: {
				project: projectArg,
				ids: z.array(z.string()).optional(),
				kind: z
					.enum(["zoom", "trim", "speed", "annotation", "all"])
					.optional()
					.describe("Remove every region of this kind"),
				only_auto: z.boolean().default(false).describe("With kind zoom: only auto-generated zooms"),
			},
			annotations: { destructiveHint: true },
		},
		async ({ project, ids, kind, only_auto }) => {
			if (!ids?.length && !kind) throw new Error("Pass ids or kind");
			const target = await openTarget(project);
			const { editor } = target;
			const removed: string[] = [];
			const keep = <T extends { id: string }>(
				regions: T[],
				listKind: string,
				extra?: (r: T) => boolean,
			): T[] =>
				regions.filter((r) => {
					const byKind = kind === "all" || kind === listKind;
					const drop = ids?.includes(r.id) || (byKind && (extra ? extra(r) : true));
					if (drop) removed.push(r.id);
					return !drop;
				});
			editor.zoomRegions = keep(
				editor.zoomRegions,
				"zoom",
				(z) => !only_auto || z.source === "auto",
			);
			editor.trimRegions = keep(editor.trimRegions, "trim");
			editor.speedRegions = keep(editor.speedRegions, "speed");
			editor.annotationRegions = keep(editor.annotationRegions, "annotation");
			const missing = ids?.filter((id) => !removed.includes(id)) ?? [];
			if (removed.length === 0)
				throw new Error(`Nothing matched${missing.length ? `: ${missing.join(", ")}` : ""}`);
			return commit(target, `removed ${removed.length} region${removed.length === 1 ? "" : "s"}`, {
				removed,
				...(missing.length ? { not_found: missing } : {}),
			});
		},
	);

	server.registerTool(
		"auto_zoom",
		{
			title: "Auto zoom",
			description:
				"Adds zooms from the cursor telemetry. 'clicks' zooms around each burst of clicks; 'dwell' matches the editor's magic wand (zooms where the cursor pauses). New zooms are marked auto, never overlap existing ones, and skip clicks inside cut sections.",
			inputSchema: {
				project: projectArg,
				strategy: z.enum(["clicks", "dwell"]).default("clicks"),
				scale: z.number().min(MIN_ZOOM_SCALE).max(MAX_ZOOM_SCALE).default(1.8),
				lead_seconds: z
					.number()
					.min(0)
					.max(5)
					.default(0.6)
					.describe("clicks: zoom in this long before the first click"),
				hold_seconds: z
					.number()
					.min(0)
					.max(10)
					.default(1.5)
					.describe("clicks: stay zoomed this long after the last click"),
				min_seconds: z.number().min(0.5).max(20).default(2).describe("clicks: shortest zoom"),
				group_gap_seconds: z
					.number()
					.min(0)
					.max(10)
					.default(2.5)
					.describe("clicks: clicks closer than this share a zoom"),
				replace_auto: z
					.boolean()
					.default(true)
					.describe("Remove earlier auto zooms first (manual zooms are kept)"),
				dry_run: z.boolean().default(false).describe("Only report what would be added"),
			},
		},
		async (args) => {
			const target = await openTarget(args.project);
			const samples = await loadCursorSamples(target.videoPath);
			if (samples.length === 0)
				throw new Error("This recording has no cursor telemetry to zoom from.");
			const total = target.totalMs ?? samples[samples.length - 1].timeMs;
			const { editor } = target;
			const kept = args.replace_auto
				? editor.zoomRegions.filter((z) => z.source !== "auto")
				: editor.zoomRegions;
			const reserved = kept.map((z) => ({ start: z.startMs, end: z.endMs }));
			const trims = editor.trimRegions.map((t) => ({ start: t.startMs, end: t.endMs }));
			const visible = samples.filter(
				(s) => !trims.some((t) => s.timeMs >= t.start && s.timeMs < t.end),
			);
			const planned =
				args.strategy === "clicks"
					? planClickZooms({
							clicks: visible.filter(isClick),
							totalMs: total,
							reserved,
							leadMs: ms(args.lead_seconds),
							holdMs: ms(args.hold_seconds),
							minMs: ms(args.min_seconds),
							maxGapMs: ms(args.group_gap_seconds),
						})
					: planDwellZooms({ samples: visible, totalMs: total, reserved });

			const zooms = [...kept];
			const added: ZoomRegion[] = [];
			for (const span of planned) {
				const zoom: ZoomRegion = {
					id: nextId("zoom", [...editor.zoomRegions, ...zooms]),
					startMs: span.start,
					endMs: span.end,
					depth: depthForScale(args.scale),
					customScale: Math.round(args.scale * 100) / 100,
					focus: { cx: span.cx, cy: span.cy },
					focusMode: "manual",
					source: "auto",
				};
				zooms.push(zoom);
				added.push(zoom);
			}
			const replaced = editor.zoomRegions.filter((z) => !kept.includes(z)).map((z) => z.id);
			const summary = {
				strategy: args.strategy,
				added: added.map(describeZoom),
				replaced_auto: replaced,
			};
			if (args.dry_run) return reply({ dry_run: true, ...summary });
			if (added.length === 0 && replaced.length === 0)
				return reply({ ...summary, note: "No new zooms found." });
			editor.zoomRegions = zooms;
			return commit(
				target,
				`added ${added.length} auto zoom${added.length === 1 ? "" : "s"}`,
				summary,
			);
		},
	);

	server.registerTool(
		"trim_dead_air",
		{
			title: "Cut dead air",
			description:
				"Finds and cuts stretches where nothing happens: the cursor is still, the audio is silent (if there is audio) and the screen isn't changing, all at once. Needs FFmpeg for audio and screen checks. Try dry_run first.",
			inputSchema: {
				project: projectArg,
				min_seconds: z
					.number()
					.min(0.5)
					.default(3)
					.describe("Only cut stretches at least this long"),
				padding_seconds: z
					.number()
					.min(0)
					.max(3)
					.default(0.5)
					.describe("Keep this much on each side of a cut"),
				use_cursor: z.boolean().default(true),
				use_audio: z.boolean().default(true),
				use_screen: z.boolean().default(true),
				silence_db: z
					.number()
					.min(-90)
					.max(-10)
					.default(-35)
					.describe("Audio quieter than this is silence"),
				dry_run: z.boolean().default(false),
			},
		},
		async (args) => {
			const target = await openTarget(args.project);
			const total = requireDuration(target);
			const minMs = ms(args.min_seconds);
			const signals: Record<string, Span[]> = {};
			const skipped: string[] = [];
			const info =
				hasFfmpeg() && existsSync(target.videoPath)
					? await probeVideo(target.videoPath).catch(() => null)
					: null;

			if (args.use_cursor) {
				const samples = await loadCursorSamples(target.videoPath);
				if (samples.length) signals.cursor = cursorIdleSpans(samples, total, minMs);
				else skipped.push("cursor (no telemetry)");
			}
			if (args.use_audio) {
				if (!info) skipped.push("audio (FFmpeg missing)");
				else if (!info.hasAudio) skipped.push("audio (recording has no audio)");
				else signals.audio = await detectSilence(target.videoPath, total, minMs, args.silence_db);
			}
			if (args.use_screen) {
				if (!info) skipped.push("screen (FFmpeg missing)");
				else signals.screen = await detectFrozenScreen(target.videoPath, total, minMs);
			}
			const used = Object.keys(signals);
			if (used.length === 0)
				throw new Error(`No signal available to detect dead air (skipped: ${skipped.join(", ")})`);

			let dead = Object.values(signals).reduce((acc, spans) => intersectSpans(acc, spans));
			dead = dead.filter((s) => s.end - s.start >= minMs);
			dead = shrinkSpans(dead, ms(args.padding_seconds), 500, total);
			dead = subtractSpans(
				dead,
				target.editor.trimRegions.map((t) => ({ start: t.startMs, end: t.endMs })),
			);
			dead = dead.filter((s) => s.end - s.start >= 500);

			const before = outputDurationMs(total, target.editor.trimRegions, target.editor.speedRegions);
			const summary = {
				signals_used: used,
				...(skipped.length ? { signals_skipped: skipped } : {}),
				cuts: dead.map((s) => ({
					start: sec(s.start),
					end: sec(s.end),
					seconds: sec(s.end - s.start),
				})),
				seconds_removed: sec(dead.reduce((sum, s) => sum + s.end - s.start, 0)),
			};
			if (args.dry_run || dead.length === 0) {
				return reply({ dry_run: args.dry_run, output_duration_now: sec(before), ...summary });
			}
			const trimIds = dead.map((span) => addTrimMerged(target.editor, span).id);
			return commit(target, `cut ${dead.length} dead-air section${dead.length === 1 ? "" : "s"}`, {
				...summary,
				trim_ids: trimIds,
				output_duration_before: sec(before),
			});
		},
	);

	server.registerTool(
		"set_style",
		{
			title: "Set style",
			description: "Changes the look and export settings. Only fields you pass change.",
			inputSchema: {
				project: projectArg,
				wallpaper: z
					.string()
					.optional()
					.describe(
						`Built-in wallpaper number 1-${WALLPAPER_COUNT}, a colour like #101418, or a CSS gradient`,
					),
				padding: z.number().min(0).max(100).optional().describe("Space around the video, 0-100"),
				border_radius: z.number().min(0).max(64).optional().describe("Corner rounding in px, 0-64"),
				shadow: z.number().min(0).max(1).optional().describe("Shadow strength, 0-1"),
				background_blur: z.boolean().optional().describe("Blur the wallpaper"),
				motion_blur: z.number().min(0).max(1).optional().describe("Zoom motion blur, 0-1"),
				aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
				crop: z
					.object({ x: fraction, y: fraction, width: fraction, height: fraction })
					.optional()
					.describe("Part of the recording to keep, as fractions"),
				cursor_theme: z.string().optional(),
				webcam_layout: z
					.enum(["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"])
					.optional(),
				webcam_shape: z.enum(["rectangle", "circle", "square", "rounded"]).optional(),
				webcam_size: z
					.number()
					.min(10)
					.max(50)
					.optional()
					.describe("Webcam size, 10-50 (% of canvas)"),
				webcam_mirrored: z.boolean().optional(),
				export_format: z.enum(["mp4", "gif"]).optional(),
				export_quality: z.enum(["medium", "good", "source"]).optional(),
				gif_frame_rate: z
					.union([z.literal(15), z.literal(20), z.literal(25), z.literal(30)])
					.optional(),
				gif_size: z.enum(["medium", "large", "original"]).optional(),
				gif_loop: z.boolean().optional(),
			},
		},
		async (args) => {
			const target = await openTarget(args.project);
			const e = target.editor;
			const changed: string[] = [];
			const set = <K extends keyof ProjectEditorState>(
				key: K,
				value: ProjectEditorState[K] | undefined,
			) => {
				if (value === undefined) return;
				e[key] = value;
				changed.push(key);
			};
			if (args.wallpaper !== undefined) {
				const trimmed = args.wallpaper.trim();
				if (/^\d+$/.test(trimmed)) {
					const n = Number(trimmed);
					if (n < 1 || n > WALLPAPER_COUNT)
						throw new Error(`Wallpaper number must be 1-${WALLPAPER_COUNT}`);
					set("wallpaper", `/wallpapers/wallpaper${n}.jpg`);
				} else {
					set("wallpaper", trimmed);
				}
			}
			set("padding", args.padding);
			set("borderRadius", args.border_radius);
			set("shadowIntensity", args.shadow);
			set("showBlur", args.background_blur);
			set("motionBlurAmount", args.motion_blur);
			set("aspectRatio", args.aspect_ratio);
			if (args.crop) {
				const { x, y } = args.crop;
				set("cropRegion", {
					x,
					y,
					width: clamp(args.crop.width, 0.01, 1 - x),
					height: clamp(args.crop.height, 0.01, 1 - y),
				});
			}
			set("cursorTheme", args.cursor_theme);
			set("webcamLayoutPreset", args.webcam_layout);
			set("webcamMaskShape", args.webcam_shape);
			set("webcamSizePreset", args.webcam_size);
			set("webcamMirrored", args.webcam_mirrored);
			set("exportFormat", args.export_format);
			set("exportQuality", args.export_quality);
			set("gifFrameRate", args.gif_frame_rate);
			set("gifSizePreset", args.gif_size);
			set("gifLoop", args.gif_loop);
			if (changed.length === 0) throw new Error("Nothing to change");
			return commit(target, "changed the style", { changed, style: describeStyle(e) });
		},
	);

	server.registerTool(
		"copy_style",
		{
			title: "Copy style",
			description:
				"Copies the look (wallpaper, padding, corners, shadow, aspect ratio, webcam layout, cursor theme, export settings) from one project to others so videos match. Leave out from to copy from the open project. Timeline edits and crop aren't copied.",
			inputSchema: {
				from: projectArg,
				to: z.array(z.string()).min(1).describe("Projects to apply it to (paths)"),
			},
		},
		async ({ from, to }) => {
			const source = await openTarget(from);
			const results: Array<{ project: string; ok: boolean; live?: boolean; error?: string }> = [];
			for (const projectPath of to) {
				try {
					const target = await openTarget(projectPath);
					for (const key of STYLE_KEYS) {
						(target.editor as unknown as Record<string, unknown>)[key] = structuredClone(
							source.editor[key],
						);
					}
					if (target.live)
						await bridge.request({
							method: "applyEditor",
							editor: target.editor,
							label: "copied a style",
						});
					else if (target.path) await writeProjectFile(env.historyDir, target.path, target.data);
					results.push({ project: target.path ?? projectPath, ok: true, live: target.live });
				} catch (error) {
					results.push({ project: projectPath, ok: false, error: (error as Error).message });
				}
			}
			return reply({ from: source.path, results });
		},
	);

	server.registerTool(
		"undo",
		{
			title: "Undo",
			description:
				"For the open project: undoes the editor's most recent change (like Cmd+Z, which may be the user's own edit). For a project file: restores the version before the last MCP change.",
			inputSchema: { project: projectArg },
		},
		async ({ project }) => {
			const target = await openTarget(project);
			if (target.live) {
				await bridge.request({ method: "undo" });
				return reply({ undone: true, ...(await describe(await openTarget(project))) });
			}
			if (!target.path) throw new Error("Nothing to undo");
			const result = await undoProjectFile(env.historyDir, target.path);
			return reply({ ...result, ...(await describe(await openTarget(target.path))) });
		},
	);

	return server;
}
