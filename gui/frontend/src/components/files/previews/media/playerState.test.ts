import { describe, expect, it } from "vitest";
import { errorOutcome, initialPlayerState, MEDIA_ERR, playerReducer, scrubberValue, type PlayerEvent, type PlayerState } from "./playerState";

const run = (events: PlayerEvent[], from: PlayerState = initialPlayerState) => events.reduce(playerReducer, from);
const facts = { duration: 42, width: 1440, height: 900 };
const ranges = [{ start: 0, end: 10 }];

describe("playerReducer", () => {
  it("loads, plays, keeps time and the buffered end, and stops at the end", () => {
    const s = run([{ type: "source" }, { type: "meta", facts }, { type: "play" }, { type: "time", time: 3, ranges }]);
    expect(s).toMatchObject({ status: "ready", fresh: false, playing: true, time: 3, buffered: 10, facts });
    expect(run([{ type: "progress", ranges: [{ start: 0, end: 20 }] }], s).buffered).toBe(20);
    expect(run([{ type: "ended" }], s)).toMatchObject({ playing: false, time: 42 });
  });

  it("a drag is not fought by timeupdate: the thumb stays under the pointer, the clock runs behind it", () => {
    const ready = run([{ type: "source" }, { type: "meta", facts }, { type: "time", time: 3, ranges }]);
    const dragging = run([{ type: "scrub", value: 30 }, { type: "time", time: 3.25, ranges }, { type: "scrub", value: 31 }, { type: "time", time: 3.5, ranges }], ready);
    expect(scrubberValue(dragging)).toBe(31);
    expect(dragging.time).toBe(3.5);
    const dropped = run([{ type: "scrubEnd" }], dragging);
    expect(dropped.scrub).toBeNull();
    expect(scrubberValue(dropped)).toBe(31);
  });

  it("a new URL loads again but keeps what it knew, so the meta does not flicker", () => {
    const s = run([{ type: "source" }, { type: "meta", facts }, { type: "play" }, { type: "time", time: 20, ranges }, { type: "source" }]);
    expect(s).toMatchObject({ status: "loading", fresh: true, playing: false, facts, time: 20 });
  });

  it("a duration that grows (a file still being written) follows once known", () => {
    expect(run([{ type: "duration", duration: 9 }]).facts).toBeNull();
    expect(run([{ type: "meta", facts }, { type: "duration", duration: 50 }]).facts?.duration).toBe(50);
  });
});

describe("errorOutcome", () => {
  it.each<[string, PlayerEvent[], number, ReturnType<typeof errorOutcome>]>([
    ["a stopped load is nothing", [{ type: "source" }], MEDIA_ERR.aborted, "ignore"],
    ["a new URL WebKit cannot decode: cannot play", [{ type: "source" }], MEDIA_ERR.srcNotSupported, "unplayable"],
    ["a new URL that fails to decode: cannot play", [{ type: "source" }], MEDIA_ERR.decode, "unplayable"],
    ["a new URL the daemon does not answer: failed", [{ type: "source" }], MEDIA_ERR.network, "failed"],
    // A daemon restart: the old URL is 404 now, which WebKit reports as "not supported".
    ["a URL that played, now 404: ask again", [{ type: "source" }, { type: "meta", facts }], MEDIA_ERR.srcNotSupported, "regrant"],
    ["a URL that played, connection dropped: ask again", [{ type: "source" }, { type: "meta", facts }], MEDIA_ERR.network, "regrant"],
    // Asked again and the new one fails before loading: it is the file after all.
    ["the re-asked URL fails too: cannot play", [{ type: "source" }, { type: "meta", facts }, { type: "source" }], MEDIA_ERR.srcNotSupported, "unplayable"],
  ])("%s", (_, events, code, want) => {
    expect(errorOutcome(run(events), code)).toBe(want);
  });
});
