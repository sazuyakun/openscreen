import { describe, expect, it } from "vitest";
import {
	clusterClicks,
	cursorIdleSpans,
	intersectSpans,
	outputDurationMs,
	planClickZooms,
	shrinkSpans,
	subtractSpans,
	videoRectToCanvasPercent,
} from "./timeline";

describe("MCP timeline helpers", () => {
	it("intersects and subtracts spans", () => {
		expect(
			intersectSpans(
				[{ start: 0, end: 10 }],
				[
					{ start: 5, end: 15 },
					{ start: 20, end: 30 },
				],
			),
		).toEqual([{ start: 5, end: 10 }]);
		expect(subtractSpans([{ start: 0, end: 10 }], [{ start: 3, end: 4 }])).toEqual([
			{ start: 0, end: 3 },
			{ start: 4, end: 10 },
		]);
	});

	it("computes output length after trims and speed changes", () => {
		const trims = [{ id: "trim-1", startMs: 0, endMs: 2000 }];
		const speeds = [{ id: "speed-1", startMs: 4000, endMs: 8000, speed: 2 }];
		// 10s - 2s cut = 8s, of which 4s plays at 2x -> 6s.
		expect(outputDurationMs(10_000, trims, speeds)).toBe(6000);
	});

	it("groups clicks close in time and space", () => {
		const clusters = clusterClicks(
			[
				{ timeMs: 1000, cx: 0.2, cy: 0.2 },
				{ timeMs: 1500, cx: 0.22, cy: 0.2 },
				{ timeMs: 9000, cx: 0.8, cy: 0.8 },
			],
			2000,
		);
		expect(clusters).toHaveLength(2);
		expect(clusters[0].count).toBe(2);
	});

	it("plans click zooms that avoid existing zooms", () => {
		const planned = planClickZooms({
			clicks: [
				{ timeMs: 5000, cx: 0.5, cy: 0.5, interactionType: "click" },
				{ timeMs: 20_000, cx: 0.1, cy: 0.9, interactionType: "click" },
			],
			totalMs: 30_000,
			reserved: [{ start: 19_000, end: 25_000 }],
			leadMs: 600,
			holdMs: 1500,
			minMs: 2000,
			maxGapMs: 2500,
		});
		expect(planned).toHaveLength(1);
		expect([planned[0].start, planned[0].end]).toEqual([4400, 6500]);
	});

	it("finds still-cursor stretches broken by movement and clicks", () => {
		const spans = cursorIdleSpans(
			[
				{ timeMs: 0, cx: 0.5, cy: 0.5 },
				{ timeMs: 1000, cx: 0.6, cy: 0.5 },
				{ timeMs: 6000, cx: 0.6, cy: 0.5, interactionType: "click" },
				{ timeMs: 7000, cx: 0.9, cy: 0.5 },
			],
			12_000,
			3000,
		);
		expect(spans).toEqual([
			{ start: 1000, end: 6000 },
			{ start: 7000, end: 12_000 },
		]);
		expect(shrinkSpans(spans, 500, 1000, 12_000)).toEqual([
			{ start: 1500, end: 5500 },
			{ start: 7500, end: 12_000 },
		]);
	});

	it("maps a video rect into the padded canvas", () => {
		// 16:9 video in a 16:9 canvas with padding 50 -> scaled to 80%, 10% margin each side.
		const rect = videoRectToCanvasPercent(
			{ x: 0, y: 0, width: 1, height: 1 },
			{ width: 1920, height: 1080 },
			{
				aspectRatio: "16:9",
				padding: 50,
				cropRegion: { x: 0, y: 0, width: 1, height: 1 },
				webcamLayoutPreset: "picture-in-picture",
			},
		);
		expect(rect.x).toBeCloseTo(10);
		expect(rect.y).toBeCloseTo(10);
		expect(rect.width).toBeCloseTo(80);
		expect(rect.height).toBeCloseTo(80);
	});
});
