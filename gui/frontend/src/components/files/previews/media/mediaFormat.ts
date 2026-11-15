/**
 * The player's words and numbers: times as a clock reads them, the file type's name, row
 * two's meta, and which buffered range the scrubber shows. Pure.
 */
import { extOf } from "@/lib/filePath";
import { formatSize } from "../../fileKind";

/** "0:07", "4:32", "1:02:03"; "--:--" for a time not known (a stream of no set length, NaN before metadata). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

/** A playback speed as the speed menu shows it: "0.5×", "1×", "1.25×". */
export function rateLabel(rate: number): string {
  return `${String(rate)}×`;
}

/** Names that are not the extension in capitals. */
const TYPE_NAMES: Readonly<Record<string, string>> = { webm: "WebM", ogg: "Ogg" };

/** The type as row two names it: "WebM", "MP4", "MP3"; the mime when the name has no extension. */
export function mediaTypeName(path: string, mime: string): string {
  const ext = extOf(path);
  return TYPE_NAMES[ext] ?? (ext.toUpperCase() || mime);
}

/** What the element told once its metadata loaded. */
export interface MediaFacts {
  /** Seconds; NaN or Infinity when it has no set length. */
  duration: number;
  /** The video's frame; 0 for audio (or a video file with no picture). */
  width: number;
  height: number;
}

/** Row two: "0:42 · 1440 × 900 · 3.1 MB · WebM", "1:12 · 1.1 MB · MP3"; size and type alone before the metadata. */
export function mediaMeta(size: number, path: string, mime: string, facts?: MediaFacts): string {
  const parts: string[] = [];
  if (facts && Number.isFinite(facts.duration)) parts.push(formatTime(facts.duration));
  if (facts && facts.width > 0 && facts.height > 0) parts.push(`${String(facts.width)} × ${String(facts.height)}`);
  parts.push(formatSize(size), mediaTypeName(path, mime));
  return parts.join(" · ");
}

/** A buffered range, as TimeRanges gives them, in seconds. */
export interface Range {
  start: number;
  end: number;
}

/** TimeRanges as a plain list. */
export function rangesOf(r: TimeRanges): Range[] {
  return Array.from({ length: r.length }, (_, i) => ({ start: r.start(i), end: r.end(i) }));
}

/**
 * Where the buffered stretch the playhead is in ends: what plays without waiting. Ranges ahead
 * of it (a seek's) are not counted, and it is `time` itself when nothing at the playhead is
 * buffered. A small gap before the playhead (the element's rounding) still counts as in.
 */
export function bufferedEnd(ranges: readonly Range[], time: number): number {
  const slack = 0.25;
  const hit = ranges.find((r) => r.start - slack <= time && time <= r.end + slack);
  return hit ? Math.max(hit.end, time) : time;
}
