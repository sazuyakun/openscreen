import type { ProjectEditorState } from "../../src/components/video-editor/projectPersistence";
import type {
	AnnotationTextAnimation,
	ArrowDirection,
} from "../../src/components/video-editor/types";

export const ARROW_DIRECTIONS = [
	"up",
	"down",
	"left",
	"right",
	"up-right",
	"up-left",
	"down-right",
	"down-left",
] as const satisfies readonly ArrowDirection[];

export const TEXT_ANIMATIONS = [
	"none",
	"fade",
	"rise",
	"pop",
	"slide-left",
	"typewriter",
	"pulse",
] as const satisfies readonly AnnotationTextAnimation[];

/** Appearance settings `copy_style` carries between projects (no timeline regions, no crop). */
export const STYLE_KEYS = [
	"wallpaper",
	"shadowIntensity",
	"showBlur",
	"motionBlurAmount",
	"borderRadius",
	"padding",
	"aspectRatio",
	"webcamLayoutPreset",
	"webcamMaskShape",
	"webcamMirrored",
	"webcamReactiveZoom",
	"webcamSizePreset",
	"webcamPosition",
	"exportQuality",
	"exportFormat",
	"gifFrameRate",
	"gifLoop",
	"gifSizePreset",
	"cursorTheme",
] as const satisfies ReadonlyArray<keyof ProjectEditorState>;
