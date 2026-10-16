// Reading and writing .openscreen files on disk, for projects that aren't open in the
// editor. Writes keep unknown fields and snapshot the previous version for `undo`.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	type EditorProjectData,
	normalizeProjectEditor,
	PROJECT_VERSION,
	type ProjectEditorState,
} from "../../src/components/video-editor/projectPersistence";
import type { ProjectMedia } from "../../src/lib/recordingSession";

export const PROJECT_EXTENSION = ".openscreen";
const HISTORY_LIMIT = 30;

export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function historyDirFor(historyRoot: string, projectPath: string): string {
	const hash = createHash("sha1").update(path.resolve(projectPath)).digest("hex").slice(0, 16);
	return path.join(historyRoot, `${path.basename(projectPath, PROJECT_EXTENSION)}-${hash}`);
}

export function resolveProjectPath(input: string): string {
	const resolved = path.resolve(expandHome(input));
	if (path.extname(resolved).toLowerCase() !== PROJECT_EXTENSION) {
		throw new Error(
			`Not an OpenScreen project (expected a ${PROJECT_EXTENSION} file): ${resolved}`,
		);
	}
	return resolved;
}

export function getScreenVideoPath(project: EditorProjectData): string {
	const videoPath = project.media?.screenVideoPath ?? project.videoPath;
	if (!videoPath) throw new Error("Project has no screen video path");
	return videoPath;
}

export async function readProjectFile(
	input: string,
): Promise<{ path: string; data: EditorProjectData }> {
	const projectPath = resolveProjectPath(input);
	let raw: string;
	try {
		raw = await fs.readFile(projectPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Project not found: ${projectPath}`);
		}
		throw error;
	}
	const data = JSON.parse(raw) as EditorProjectData;
	if (typeof data?.version !== "number" || !data.editor || typeof data.editor !== "object") {
		throw new Error(`File is not a valid OpenScreen project: ${projectPath}`);
	}
	getScreenVideoPath(data);
	// Older or hand-made files may miss arrays; fill them so edits can push safely.
	data.editor.zoomRegions ??= [];
	data.editor.trimRegions ??= [];
	data.editor.speedRegions ??= [];
	data.editor.annotationRegions ??= [];
	return { path: projectPath, data };
}

export async function writeProjectFile(
	historyRoot: string,
	projectPath: string,
	data: EditorProjectData,
): Promise<void> {
	if (existsSync(projectPath)) {
		const dir = historyDirFor(historyRoot, projectPath);
		await fs.mkdir(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		await fs.copyFile(projectPath, path.join(dir, `${stamp}${PROJECT_EXTENSION}`));
		const snapshots = (await fs.readdir(dir)).sort();
		for (const old of snapshots.slice(0, Math.max(0, snapshots.length - HISTORY_LIMIT))) {
			await fs.rm(path.join(dir, old), { force: true });
		}
	}
	const tmp = `${projectPath}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
	await fs.rename(tmp, projectPath);
}

/** Restores the most recent snapshot and drops it from the history. */
export async function undoProjectFile(
	historyRoot: string,
	input: string,
): Promise<{ restoredFrom: string; remaining: number }> {
	const projectPath = resolveProjectPath(input);
	const dir = historyDirFor(historyRoot, projectPath);
	const snapshots = existsSync(dir) ? (await fs.readdir(dir)).sort() : [];
	const latest = snapshots.at(-1);
	if (!latest) throw new Error("No earlier versions saved through MCP for this project");
	await fs.copyFile(path.join(dir, latest), projectPath);
	await fs.rm(path.join(dir, latest));
	return { restoredFrom: latest, remaining: snapshots.length - 1 };
}

/** Reads the `<recording>.session.json` the app writes next to each recording, if present. */
async function readSessionMedia(videoPath: string): Promise<ProjectMedia | null> {
	const parsed = path.parse(videoPath);
	try {
		const session = JSON.parse(
			await fs.readFile(path.join(parsed.dir, `${parsed.name}.session.json`), "utf-8"),
		);
		if (typeof session?.screenVideoPath !== "string") return null;
		return {
			screenVideoPath: session.screenVideoPath,
			...(typeof session.webcamVideoPath === "string"
				? { webcamVideoPath: session.webcamVideoPath }
				: {}),
			...(session.cursorCaptureMode === "editable-overlay" || session.cursorCaptureMode === "system"
				? { cursorCaptureMode: session.cursorCaptureMode }
				: {}),
		};
	} catch {
		return null;
	}
}

export async function createProjectFile(options: {
	historyRoot: string;
	videoPath: string;
	projectPath?: string;
	overwrite?: boolean;
	editor?: Partial<ProjectEditorState>;
}): Promise<{ path: string; data: EditorProjectData }> {
	const videoPath = path.resolve(expandHome(options.videoPath));
	if (!existsSync(videoPath)) throw new Error(`Video not found: ${videoPath}`);
	const parsed = path.parse(videoPath);
	const projectPath = resolveProjectPath(
		options.projectPath ?? path.join(parsed.dir, `${parsed.name}${PROJECT_EXTENSION}`),
	);
	if (existsSync(projectPath) && !options.overwrite) {
		throw new Error(`Project already exists: ${projectPath} (pass overwrite: true to replace it)`);
	}
	const media = (await readSessionMedia(videoPath)) ?? { screenVideoPath: videoPath };
	media.screenVideoPath = videoPath;
	const data: EditorProjectData = {
		version: PROJECT_VERSION,
		media,
		editor: normalizeProjectEditor(options.editor ?? {}),
	};
	await writeProjectFile(options.historyRoot, projectPath, data);
	return { path: projectPath, data };
}

export interface ProjectListing {
	projects: Array<{ path: string; video: string; modified: string; videoMissing: boolean }>;
	recordingsWithoutProject: Array<{ video: string; recorded: string }>;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv"]);

export async function listProjectFiles(dirs: string[]): Promise<ProjectListing> {
	const projects: ProjectListing["projects"] = [];
	const videos = new Map<string, Date>();
	const referenced = new Set<string>();

	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const full = path.join(dir, name);
			const ext = path.extname(name).toLowerCase();
			if (ext === PROJECT_EXTENSION) {
				try {
					const { data } = await readProjectFile(full);
					const video = getScreenVideoPath(data);
					referenced.add(path.resolve(video));
					if (data.media?.webcamVideoPath) referenced.add(path.resolve(data.media.webcamVideoPath));
					const stat = await fs.stat(full);
					projects.push({
						path: full,
						video,
						modified: stat.mtime.toISOString(),
						videoMissing: !existsSync(video),
					});
				} catch {
					// Skip unreadable or foreign files.
				}
			} else if (VIDEO_EXTENSIONS.has(ext) && !/webcam/i.test(name)) {
				const stat = await fs.stat(full);
				videos.set(path.resolve(full), stat.mtime);
			}
		}
	}

	const recordingsWithoutProject = [...videos.entries()]
		.filter(([video]) => !referenced.has(video))
		.sort((a, b) => b[1].getTime() - a[1].getTime())
		.map(([video, mtime]) => ({ video, recorded: mtime.toISOString() }));
	projects.sort((a, b) => b.modified.localeCompare(a.modified));
	return { projects, recordingsWithoutProject };
}
