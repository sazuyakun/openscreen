import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Span } from "./timeline";

const execFileAsync = promisify(execFile);

// MCP hosts often launch servers with a minimal PATH, so also try the usual install spots.
const FALLBACK_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

function findBinary(name: "ffmpeg" | "ffprobe"): string | null {
	const override = process.env[name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"];
	if (override) return override;
	const exe = process.platform === "win32" ? `${name}.exe` : name;
	const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...FALLBACK_BIN_DIRS];
	for (const dir of dirs) {
		if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
	}
	return null;
}

function requireBinary(name: "ffmpeg" | "ffprobe"): string {
	const bin = findBinary(name);
	if (!bin) {
		throw new Error(
			`${name} not found. Install FFmpeg (e.g. \`brew install ffmpeg\`) or set ${name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH"}.`,
		);
	}
	return bin;
}

export function hasFfmpeg(): boolean {
	return findBinary("ffmpeg") !== null && findBinary("ffprobe") !== null;
}

export interface VideoInfo {
	durationMs: number;
	width: number;
	height: number;
	hasAudio: boolean;
}

const probeCache = new Map<string, { mtimeMs: number; info: VideoInfo }>();

export async function probeVideo(videoPath: string): Promise<VideoInfo> {
	const mtimeMs = statSync(videoPath).mtimeMs;
	const cached = probeCache.get(videoPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.info;

	const { stdout } = await execFileAsync(requireBinary("ffprobe"), [
		"-v",
		"error",
		"-show_entries",
		"format=duration:stream=codec_type,width,height,duration",
		"-of",
		"json",
		videoPath,
	]);
	const parsed = JSON.parse(stdout) as {
		format?: { duration?: string };
		streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
	};
	const video = parsed.streams?.find((s) => s.codec_type === "video");
	const durationSec = Number(parsed.format?.duration ?? video?.duration);
	if (!video || !Number.isFinite(durationSec)) {
		throw new Error(`Could not read video duration/size from ${videoPath}`);
	}
	const info: VideoInfo = {
		durationMs: Math.round(durationSec * 1000),
		width: video.width ?? 0,
		height: video.height ?? 0,
		hasAudio: Boolean(parsed.streams?.some((s) => s.codec_type === "audio")),
	};
	probeCache.set(videoPath, { mtimeMs, info });
	return info;
}

/** Grabs one frame as JPEG, scaled down to at most `maxWidth` pixels wide. */
export async function extractFrame(
	videoPath: string,
	timeMs: number,
	maxWidth = 1280,
): Promise<Buffer> {
	const { stdout } = await execFileAsync(
		requireBinary("ffmpeg"),
		[
			"-v",
			"error",
			"-ss",
			(timeMs / 1000).toFixed(3),
			"-i",
			videoPath,
			"-frames:v",
			"1",
			"-vf",
			`scale='min(${maxWidth},iw)':-2`,
			"-q:v",
			"4",
			"-f",
			"image2pipe",
			"-vcodec",
			"mjpeg",
			"-",
		],
		{ encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
	);
	if (stdout.length === 0) throw new Error(`No frame at ${timeMs}ms (past the end of the video?)`);
	return stdout;
}

/** Runs ffmpeg for its stderr log only (filters like silencedetect/freezedetect report there). */
function runFfmpegLog(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(requireBinary("ffmpeg"), [
			"-hide_banner",
			"-nostats",
			...args,
			"-f",
			"null",
			"-",
		]);
		const lines: string[] = [];
		let buffer = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			buffer += chunk;
			const parts = buffer.split(/\r?\n/);
			buffer = parts.pop() ?? "";
			for (const line of parts) if (line.includes("detect")) lines.push(line);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (buffer.includes("detect")) lines.push(buffer);
			if (code === 0) resolve(lines.join("\n"));
			else reject(new Error(`ffmpeg exited with code ${code}`));
		});
	});
}

function pairSpans(log: string, startKey: string, endKey: string, totalMs: number): Span[] {
	const spans: Span[] = [];
	let open: number | null = null;
	const re = new RegExp(`(${startKey}|${endKey}):\\s*(-?[\\d.]+)`, "g");
	for (const match of log.matchAll(re)) {
		const ms = Math.round(Number(match[2]) * 1000);
		if (match[1] === startKey) open = Math.max(0, ms);
		else if (open !== null) {
			spans.push({ start: open, end: Math.min(ms, totalMs) });
			open = null;
		}
	}
	if (open !== null) spans.push({ start: open, end: totalMs });
	return spans.filter((s) => s.end > s.start);
}

export async function detectSilence(
	videoPath: string,
	totalMs: number,
	minMs: number,
	noiseDb = -35,
): Promise<Span[]> {
	const log = await runFfmpegLog([
		"-i",
		videoPath,
		"-vn",
		"-af",
		`silencedetect=noise=${noiseDb}dB:d=${(minMs / 1000).toFixed(2)}`,
	]);
	return pairSpans(log, "silence_start", "silence_end", totalMs);
}

/** Spans where the picture doesn't change. Sampled at low fps/size so long recordings stay quick. */
export async function detectFrozenScreen(
	videoPath: string,
	totalMs: number,
	minMs: number,
): Promise<Span[]> {
	const log = await runFfmpegLog([
		"-i",
		videoPath,
		"-an",
		"-vf",
		`fps=5,scale=480:-2,freezedetect=n=0.002:d=${(minMs / 1000).toFixed(2)}`,
	]);
	return pairSpans(
		log,
		"lavfi.freezedetect.freeze_start",
		"lavfi.freezedetect.freeze_end",
		totalMs,
	);
}
