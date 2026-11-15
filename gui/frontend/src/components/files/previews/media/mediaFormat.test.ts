import { describe, expect, it } from "vitest";
import { bufferedEnd, formatTime, mediaMeta, mediaTypeName, rateLabel } from "./mediaFormat";

describe("formatTime", () => {
  it.each<[number, string]>([
    [0, "0:00"],
    [7.9, "0:07"],
    [42, "0:42"],
    [72, "1:12"],
    [599.99, "9:59"],
    [3600, "1:00:00"],
    [3723, "1:02:03"],
    [Number.NaN, "--:--"],
    [Number.POSITIVE_INFINITY, "--:--"],
    [-1, "--:--"],
  ])("%s s → %s", (s, want) => {
    expect(formatTime(s)).toBe(want);
  });
});

describe("row two", () => {
  it.each<[string, string, string]>([
    ["/w/thread-open.webm", "video/webm", "WebM"],
    ["/w/clip.MP4", "video/mp4", "MP4"],
    ["/w/talk.mov", "video/quicktime", "MOV"],
    ["/w/song.mp3", "audio/mpeg", "MP3"],
    ["/w/song.ogg", "audio/ogg", "Ogg"],
    ["/w/noext", "audio/flac", "audio/flac"],
  ])("%s is %s… named %s", (path, mime, want) => {
    expect(mediaTypeName(path, mime)).toBe(want);
  });

  it("is size and type before the metadata, then length and frame first", () => {
    const size = Math.round(3.1 * 1024 * 1024);
    expect(mediaMeta(size, "/w/a.webm", "video/webm")).toBe("3.1 MB · WebM");
    expect(mediaMeta(size, "/w/a.webm", "video/webm", { duration: 42.4, width: 1440, height: 900 })).toBe("0:42 · 1440 × 900 · 3.1 MB · WebM");
    expect(mediaMeta(Math.round(1.1 * 1024 * 1024), "/w/a.mp3", "audio/mpeg", { duration: 72, width: 0, height: 0 })).toBe("1:12 · 1.1 MB · MP3");
    // No set length (a stream still being written): no time rather than "--:--".
    expect(mediaMeta(2048, "/w/a.mp4", "video/mp4", { duration: Number.POSITIVE_INFINITY, width: 160, height: 90 })).toBe("160 × 90 · 2 KB · MP4");
  });

  it("names a speed as the menu does", () => {
    expect([0.5, 1, 1.25, 1.5, 2].map(rateLabel)).toEqual(["0.5×", "1×", "1.25×", "1.5×", "2×"]);
  });
});

describe("bufferedEnd", () => {
  it.each<[string, { start: number; end: number }[], number, number]>([
    ["nothing buffered", [], 3, 3],
    ["the range the playhead is in", [{ start: 0, end: 12 }], 4, 12],
    ["not a range ahead of it (a seek's)", [{ start: 0, end: 2 }, { start: 30, end: 40 }], 5, 5],
    ["the later range after a seek into it", [{ start: 0, end: 2 }, { start: 30, end: 40 }], 31, 40],
    ["a rounding gap just before the range", [{ start: 10.1, end: 20 }], 10, 20],
  ])("%s", (_, ranges, time, want) => {
    expect(bufferedEnd(ranges, time)).toBe(want);
  });
});
