import fs from "node:fs/promises";
import type { CursorSample } from "./timeline";

/**
 * Reads the cursor telemetry OpenScreen saves next to each recording as
 * `<video>.cursor.json` (either `{ samples: [...] }` or a bare array).
 * Returns an empty list when the recording has none.
 */
export async function loadCursorSamples(videoPath: string): Promise<CursorSample[]> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(`${videoPath}.cursor.json`, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const raw = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { samples?: unknown })?.samples)
			? (parsed as { samples: unknown[] }).samples
			: [];
	return raw
		.filter((s): s is CursorSample => {
			const sample = s as Partial<CursorSample>;
			return (
				typeof sample?.timeMs === "number" &&
				typeof sample.cx === "number" &&
				typeof sample.cy === "number" &&
				Number.isFinite(sample.timeMs + sample.cx + sample.cy)
			);
		})
		.map((s) => ({
			timeMs: Math.max(0, s.timeMs),
			cx: s.cx,
			cy: s.cy,
			interactionType: typeof s.interactionType === "string" ? s.interactionType : "move",
		}))
		.sort((a, b) => a.timeMs - b.timeMs);
}
