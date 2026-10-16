// Pure timeline helpers. All times are milliseconds of the source recording.

import type { ProjectEditorState } from "../../src/components/video-editor/projectPersistence";
import type { CropRegion, SpeedRegion, TrimRegion } from "../../src/components/video-editor/types";

export interface Span {
	start: number;
	end: number;
}

export interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType?: string;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function overlaps(a: Span, b: Span): boolean {
	return a.start < b.end && b.start < a.end;
}

export function mergeSpans(spans: Span[]): Span[] {
	const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
	const merged: Span[] = [];
	for (const span of sorted) {
		const last = merged.at(-1);
		if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
		else merged.push({ ...span });
	}
	return merged;
}

export function intersectSpans(a: Span[], b: Span[]): Span[] {
	const out: Span[] = [];
	for (const x of mergeSpans(a)) {
		for (const y of mergeSpans(b)) {
			const start = Math.max(x.start, y.start);
			const end = Math.min(x.end, y.end);
			if (end > start) out.push({ start, end });
		}
	}
	return mergeSpans(out);
}

export function subtractSpans(from: Span[], remove: Span[]): Span[] {
	let result = mergeSpans(from);
	for (const cut of mergeSpans(remove)) {
		result = result.flatMap((span) => {
			if (!overlaps(span, cut)) return [span];
			const pieces: Span[] = [];
			if (cut.start > span.start) pieces.push({ start: span.start, end: cut.start });
			if (cut.end < span.end) pieces.push({ start: cut.end, end: span.end });
			return pieces;
		});
	}
	return result;
}

/** Length of the exported video after trims and speed regions are applied. */
export function outputDurationMs(
	totalMs: number,
	trims: TrimRegion[],
	speeds: SpeedRegion[],
): number {
	const kept = subtractSpans(
		[{ start: 0, end: totalMs }],
		trims.map((t) => ({ start: t.startMs, end: t.endMs })),
	);
	let duration = 0;
	for (const span of kept) {
		let covered = 0;
		for (const speed of speeds) {
			const start = Math.max(span.start, speed.startMs);
			const end = Math.min(span.end, speed.endMs);
			if (end > start) {
				duration += (end - start) / speed.speed;
				covered += end - start;
			}
		}
		duration += span.end - span.start - covered;
	}
	return Math.round(duration);
}

export function isClick(sample: CursorSample): boolean {
	return (
		sample.interactionType !== undefined &&
		sample.interactionType !== "move" &&
		sample.interactionType !== "mouseup"
	);
}

export interface ClickCluster {
	start: number;
	end: number;
	cx: number;
	cy: number;
	count: number;
}

/** Groups clicks that happen within `maxGapMs` of each other and near the same spot. */
export function clusterClicks(
	clicks: CursorSample[],
	maxGapMs: number,
	maxDistance = 0.25,
): ClickCluster[] {
	const clusters: Array<CursorSample[]> = [];
	for (const click of [...clicks].sort((a, b) => a.timeMs - b.timeMs)) {
		const current = clusters.at(-1);
		const last = current?.at(-1);
		if (
			current &&
			last &&
			click.timeMs - last.timeMs <= maxGapMs &&
			Math.hypot(click.cx - last.cx, click.cy - last.cy) <= maxDistance
		) {
			current.push(click);
		} else {
			clusters.push([click]);
		}
	}
	return clusters.map((group) => ({
		start: group[0].timeMs,
		end: group[group.length - 1].timeMs,
		cx: group.reduce((sum, c) => sum + c.cx, 0) / group.length,
		cy: group.reduce((sum, c) => sum + c.cy, 0) / group.length,
		count: group.length,
	}));
}

/**
 * Zoom spans around click clusters: start `leadMs` before the first click, hold
 * `holdMs` after the last, at least `minMs` long, never overlapping `reserved` spans.
 */
export function planClickZooms(options: {
	clicks: CursorSample[];
	totalMs: number;
	reserved: Span[];
	leadMs: number;
	holdMs: number;
	minMs: number;
	maxGapMs: number;
}): Array<Span & { cx: number; cy: number; clicks: number }> {
	const { totalMs, leadMs, holdMs, minMs, maxGapMs } = options;
	const reserved = [...options.reserved];
	const planned: Array<Span & { cx: number; cy: number; clicks: number }> = [];
	for (const cluster of clusterClicks(options.clicks, maxGapMs)) {
		let start = Math.max(0, cluster.start - leadMs);
		let end = Math.min(totalMs, cluster.end + holdMs);
		if (end - start < minMs) {
			const pad = (minMs - (end - start)) / 2;
			start = Math.max(0, start - pad);
			end = Math.min(totalMs, end + pad);
		}
		// Shrink away from neighbours instead of dropping the zoom outright.
		for (const other of reserved) {
			if (!overlaps({ start, end }, other)) continue;
			if (other.start <= cluster.start && other.end > start) start = Math.max(start, other.end);
			if (other.start > cluster.start && other.start < end) end = Math.min(end, other.start);
		}
		if (
			start > cluster.end ||
			// A zoom squeezed much shorter than asked would look like a flicker.
			end - start < minMs * 0.75 ||
			reserved.some((r) => overlaps({ start, end }, r))
		) {
			continue;
		}
		const span = { start: Math.round(start), end: Math.round(end) };
		reserved.push(span);
		planned.push({
			...span,
			cx: clamp(cluster.cx, 0, 1),
			cy: clamp(cluster.cy, 0, 1),
			clicks: cluster.count,
		});
	}
	return planned;
}

// Dwell-based suggestions: a port of buildAutoZoomSuggestions from OpenScreen's
// src/components/video-editor/timeline/zoomSuggestionUtils.ts (MIT), so results match
// the app's magic-wand button.
const MIN_DWELL_DURATION_MS = 450;
const MAX_DWELL_DURATION_MS = 2600;
const DWELL_MOVE_THRESHOLD = 0.02;
const SUGGESTION_SPACING_MS = 1800;

export function planDwellZooms(options: {
	samples: CursorSample[];
	totalMs: number;
	reserved: Span[];
}): Array<Span & { cx: number; cy: number }> {
	const { totalMs } = options;
	if (totalMs <= 0 || options.samples.length < 2) return [];
	const defaultDuration = Math.min(Math.max(1000, Math.round(totalMs * 0.05)), totalMs);
	const samples = options.samples
		.filter((s) => Number.isFinite(s.timeMs) && Number.isFinite(s.cx) && Number.isFinite(s.cy))
		.map((s) => ({
			timeMs: clamp(s.timeMs, 0, totalMs),
			cx: clamp(s.cx, 0, 1),
			cy: clamp(s.cy, 0, 1),
		}))
		.sort((a, b) => a.timeMs - b.timeMs);

	const candidates: Array<{ center: number; cx: number; cy: number; strength: number }> = [];
	const pushRun = (from: number, toExclusive: number) => {
		if (toExclusive - from < 2) return;
		const run = samples.slice(from, toExclusive);
		const duration = run[run.length - 1].timeMs - run[0].timeMs;
		if (duration < MIN_DWELL_DURATION_MS || duration > MAX_DWELL_DURATION_MS) return;
		candidates.push({
			center: Math.round((run[0].timeMs + run[run.length - 1].timeMs) / 2),
			cx: run.reduce((sum, s) => sum + s.cx, 0) / run.length,
			cy: run.reduce((sum, s) => sum + s.cy, 0) / run.length,
			strength: duration,
		});
	};
	let runStart = 0;
	for (let i = 1; i < samples.length; i += 1) {
		const moved = Math.hypot(samples[i].cx - samples[i - 1].cx, samples[i].cy - samples[i - 1].cy);
		if (moved > DWELL_MOVE_THRESHOLD) {
			pushRun(runStart, i);
			runStart = i;
		}
	}
	pushRun(runStart, samples.length);

	const reserved = [...options.reserved];
	const accepted: number[] = [];
	const planned: Array<Span & { cx: number; cy: number }> = [];
	for (const candidate of candidates.sort((a, b) => b.strength - a.strength)) {
		if (accepted.some((c) => Math.abs(c - candidate.center) < SUGGESTION_SPACING_MS)) continue;
		const start = clamp(
			Math.round(candidate.center - defaultDuration / 2),
			0,
			totalMs - defaultDuration,
		);
		const span = { start, end: start + defaultDuration };
		if (reserved.some((r) => overlaps(span, r))) continue;
		reserved.push(span);
		accepted.push(candidate.center);
		planned.push({ ...span, cx: candidate.cx, cy: candidate.cy });
	}
	return planned;
}

/** Spans of at least `minMs` where the cursor neither moves more than `threshold` nor clicks. */
export function cursorIdleSpans(
	samples: CursorSample[],
	totalMs: number,
	minMs: number,
	threshold = 0.01,
): Span[] {
	if (samples.length === 0) return totalMs >= minMs ? [{ start: 0, end: totalMs }] : [];
	const spans: Span[] = [];
	let anchor = samples[0];
	let idleStart = 0;
	for (const sample of samples) {
		const moved = Math.hypot(sample.cx - anchor.cx, sample.cy - anchor.cy) > threshold;
		if (moved || isClick(sample)) {
			if (sample.timeMs - idleStart >= minMs) spans.push({ start: idleStart, end: sample.timeMs });
			anchor = sample;
			idleStart = sample.timeMs;
		}
	}
	if (totalMs - idleStart >= minMs) spans.push({ start: idleStart, end: totalMs });
	return spans;
}

/** Shrinks each span by `paddingMs` on both sides and drops the ones that get too short. */
export function shrinkSpans(
	spans: Span[],
	paddingMs: number,
	minMs: number,
	totalMs: number,
): Span[] {
	return spans
		.map((s) => ({
			// Keep cuts flush with the very start/end of the recording.
			start: s.start <= 0 ? 0 : s.start + paddingMs,
			end: s.end >= totalMs ? totalMs : s.end - paddingMs,
		}))
		.filter((s) => s.end - s.start >= minMs);
}

const ASPECT_VALUES: Record<string, number> = {
	"16:9": 16 / 9,
	"9:16": 9 / 16,
	"1:1": 1,
	"4:3": 4 / 3,
	"4:5": 4 / 5,
	"16:10": 16 / 10,
	"10:16": 10 / 16,
};

/**
 * Maps a rectangle given as fractions of the source video frame to the percentage-of-canvas
 * coordinates annotations use. Mirrors the app's layout for screen-only and picture-in-picture
 * projects: the cropped video is fitted (contain) inside the padded canvas and centred.
 */
export function videoRectToCanvasPercent(
	rect: { x: number; y: number; width: number; height: number },
	video: { width: number; height: number },
	editor: Pick<ProjectEditorState, "aspectRatio" | "padding" | "cropRegion" | "webcamLayoutPreset">,
): { x: number; y: number; width: number; height: number } {
	if (
		editor.webcamLayoutPreset === "vertical-stack" ||
		editor.webcamLayoutPreset === "dual-frame"
	) {
		throw new Error(
			`Video-relative placement isn't supported for the "${editor.webcamLayoutPreset}" webcam layout; use canvas coordinates.`,
		);
	}
	const crop: CropRegion = editor.cropRegion ?? { x: 0, y: 0, width: 1, height: 1 };
	const croppedW = video.width * crop.width;
	const croppedH = video.height * crop.height;
	const aspect = ASPECT_VALUES[editor.aspectRatio] ?? croppedW / croppedH;
	const canvasW = 1000;
	const canvasH = canvasW / aspect;
	const paddingScale = 1 - (clamp(editor.padding ?? 0, 0, 100) / 100) * 0.4;
	const scale = Math.min((canvasW * paddingScale) / croppedW, (canvasH * paddingScale) / croppedH);
	const originX = (canvasW - croppedW * scale) / 2;
	const originY = (canvasH - croppedH * scale) / 2;
	const toCanvasX = (fx: number) => originX + (fx - crop.x) * video.width * scale;
	const toCanvasY = (fy: number) => originY + (fy - crop.y) * video.height * scale;
	return {
		x: (toCanvasX(rect.x) / canvasW) * 100,
		y: (toCanvasY(rect.y) / canvasH) * 100,
		width: ((rect.width * video.width * scale) / canvasW) * 100,
		height: ((rect.height * video.height * scale) / canvasH) * 100,
	};
}
