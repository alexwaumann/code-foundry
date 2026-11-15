import { describe, expect, it } from "vitest";
import { DEBUG, detectLevel, ERROR, FATAL, INFO, levelOfNumber, startsEntry, timeAt, TRACE, trailingFields, viewLine, WARN, type Level } from "./logLine";

describe("detectLevel", () => {
  it.each<[string, string, Level]>([
    ["slog text", 'time=2026-11-14T09:14:02.113-08:00 level=WARN msg="gh rate limit low" remaining=112', WARN],
    ["slog text, offset level", "time=2026-11-14T09:14:02Z level=DEBUG-4 msg=x", DEBUG],
    ["logfmt lower case, quoted", 'ts=1 lvl="error" msg=boom', ERROR],
    ["slog JSON", '{"time":"2026-11-14T09:14:02.113Z","level":"WARN","msg":"slow"}', WARN],
    ["zap JSON", '{"level":"error","ts":1731574442.113,"msg":"failed"}', ERROR],
    ["zap dpanic", '{"level":"dpanic","msg":"x"}', ERROR],
    ["pino numbers", '{"level":30,"time":1731574442113,"msg":"hi"}', INFO],
    ["pino 50", '{"level":50,"msg":"bad"}', ERROR],
    ["pino 60", '{"level":60,"msg":"dead"}', FATAL],
    ["pino 10", '{"level":10,"msg":"t"}', TRACE],
    ["bunyan, level later in the object", '{"name":"api","hostname":"h","pid":1,"level":40,"msg":"w"}', WARN],
    ["bracketed", "2026-11-14 09:14:02 [ERROR] worktree add failed", ERROR],
    ["bracketed lower case", "[warn] disk almost full", WARN],
    ["bare after a timestamp", "09:14:02.113 INFO daemon listening", INFO],
    ["bare at the start", "WARNING: deprecated flag", WARN],
    ["python logging", "2026-11-14 09:14:02,113 - app.db - ERROR - connection lost", ERROR],
    ["python basicConfig", "INFO:root:started", INFO],
    ["zerolog console", "9:14AM WRN slow request", WARN],
    ["syslog", "Nov 14 09:14:02 host app[123]: ERROR cannot bind", ERROR],
    ["a JSON line with no level", '{"msg":"no level"}', 0],
    ["prose with error in it", "the error was handled and nothing else happened", 0],
    ["ERROR far into a line is not a level", "we processed the first batch of rows and then saw ERROR", 0],
    ["lower-case bare word is not a level", "error handling improved", 0],
    ["empty", "", 0],
  ])("%s", (_name, line, want) => {
    expect(detectLevel(line)).toBe(want);
  });

  it.each<[number, Level]>([
    [5, 0],
    [10, TRACE],
    [25, DEBUG],
    [30, INFO],
    [49, WARN],
    [50, ERROR],
    [70, FATAL],
    [Number.NaN, 0],
  ])("pino %d", (n, want) => {
    expect(levelOfNumber(n)).toBe(want);
  });
});

describe("timeAt", () => {
  it.each<[string, string, { short: string; full: string } | null]>([
    ["ISO with zone", "2026-11-14T09:14:02.113-08:00 hi", { short: "09:14:02.113", full: "2026-11-14T09:14:02.113-08:00" }],
    ["ISO Z, nanoseconds", "2026-11-14T09:14:02.113456789Z x", { short: "09:14:02.113", full: "2026-11-14T09:14:02.113456789Z" }],
    ["ISO with a space", "2026-11-14 09:14:02 x", { short: "09:14:02", full: "2026-11-14 09:14:02" }],
    ["comma fraction", "2026-11-14 09:14:02,113 x", { short: "09:14:02.113", full: "2026-11-14 09:14:02,113" }],
    ["bracketed", "[2026-11-14T09:14:02Z] x", { short: "09:14:02", full: "2026-11-14T09:14:02Z" }],
    ["time only", "09:14:02.113 INFO x", { short: "09:14:02.113", full: "09:14:02.113" }],
    ["syslog", "Nov 14 09:14:02 host x", { short: "09:14:02", full: "Nov 14 09:14:02" }],
    ["syslog, one-digit day", "Nov  4 09:14:02 host x", { short: "09:14:02", full: "Nov  4 09:14:02" }],
    ["Go's log", "2026/11/14 09:14:02 x", { short: "09:14:02", full: "2026/11/14 09:14:02" }],
    ["not at the start", "at 09:14:02 something", null],
    ["a version is no time", "1.2.3 released", null],
    ["a longer number", "09:14:0211 x", null],
    ["a stack frame", "\tinternal/x.go:212 +0x1c4", null],
  ])("%s", (_name, line, want) => {
    const t = timeAt(line);
    expect(t && { short: t.short, full: t.full }).toEqual(want);
  });

  it("ends after the space that follows", () => {
    expect(timeAt("09:14:02   x")?.end).toBe(11);
  });

  it.each([
    ["JSON", '{"a":1}', true],
    ["logfmt time", "time=2026 level=INFO", true],
    ["a timestamp", "2026-11-14T09:14:02Z hi", true],
    ["a trace frame", "    at foo (x.js:1:2)", false],
    ["plain", "fatal: a branch named x already exists", false],
  ])("startsEntry: %s", (_name, line, want) => {
    expect(startsEntry(line)).toBe(want);
  });
});

describe("trailingFields", () => {
  it.each<[string, string, string[]]>([
    ["fields after a message", "daemon listening port=7421 version=v0.22", ["port=7421", "version=v0.22"]],
    ["a quoted value with spaces", 'failed err="exit status 128" n=3', ['err="exit status 128"', "n=3"]],
    ["an escaped quote in a value", 'x msg="say \\"hi\\"" k=v', ['msg="say \\"hi\\""', "k=v"]],
    ["only the trailing run", "a=1 then words k=v", ["k=v"]],
    ["no fields", "nothing to see", []],
    ["a word with = at the end of a message is not a key", "x == y", []],
  ])("%s", (_name, text, want) => {
    const { fields } = trailingFields(text);
    expect(fields.map((f) => text.slice(f.from, f.to))).toEqual(want);
    for (const f of fields) expect(text.charAt(f.eq)).toBe("=");
  });
});

describe("viewLine", () => {
  const msg = (v: ReturnType<typeof viewLine>) => v.text.slice(v.from, v.fieldsAt).trimEnd();
  const fields = (v: ReturnType<typeof viewLine>) => v.fields.map((f) => v.text.slice(f.from, f.to));

  it("slog text: time, level, message, fields", () => {
    const v = viewLine('time=2026-11-14T09:14:02.113-08:00 level=INFO msg="daemon listening" port=7421 version=v0.22.0-tip.3', true);
    expect(v.time).toEqual({ short: "09:14:02.113", full: "2026-11-14T09:14:02.113-08:00" });
    expect(v.level).toBe(INFO);
    expect(msg(v)).toBe("daemon listening");
    expect(fields(v)).toEqual(["port=7421", "version=v0.22.0-tip.3"]);
    expect(v.asWritten).toBe(false);
  });

  it("a JSON line: time, level, message, then the other keys", () => {
    const v = viewLine('{"time":"2026-11-14T09:14:02.113Z","level":"info","msg":"turn finished","id":"t-8f2c","steps":7,"usage":{"in":3},"note":"two words"}', true);
    expect(v.time?.short).toBe("09:14:02.113");
    expect(v.level).toBe(INFO);
    expect(msg(v)).toBe("turn finished");
    expect(fields(v)).toEqual(["id=t-8f2c", "steps=7", 'usage={"in":3}', 'note="two words"']);
  });

  it("pino: epoch milliseconds and a numeric level", () => {
    const v = viewLine('{"level":40,"time":1731574442113,"pid":1,"msg":"slow"}', true);
    expect(v.level).toBe(WARN);
    expect(v.time?.full).toBe("2024-11-14T08:54:02.113Z");
    expect(v.time?.short).toMatch(/^\d\d:54:02\.113$/);
    expect(fields(v)).toEqual(["pid=1"]);
  });

  it("a text line: the leading level word moves to the column", () => {
    const v = viewLine("2026-11-14 09:14:02 [ERROR] worktree add failed project=cf", true);
    expect(v.level).toBe(ERROR);
    expect(v.time?.short).toBe("09:14:02");
    expect(msg(v)).toBe("worktree add failed");
    expect(fields(v)).toEqual(["project=cf"]);
  });

  it("a level word that is not first stays in the text", () => {
    const v = viewLine("Nov 14 09:14:02 host app[1]: ERROR cannot bind", true);
    expect(v.level).toBe(ERROR);
    expect(msg(v)).toBe("host app[1]: ERROR cannot bind");
  });

  it("a continuation stays as written", () => {
    const v = viewLine("    internal/store/project/worktree.go:212 +0x1c4", true);
    expect(v).toMatchObject({ time: null, level: 0, from: 0, fields: [] });
  });

  it("terminal output is never reinterpreted", () => {
    const line = "2026-11-14 09:14:02 ERROR something key=value";
    expect(viewLine(line, false)).toEqual({ text: line, time: null, level: 0, from: 0, fieldsAt: line.length, fields: [], asWritten: true });
  });

  it.each([
    ["malformed JSON", '{"level":"error", "msg": '],
    ["a JSON array", "[1,2,3]"],
    ["NUL inside", "a\u0000b ERROR"],
    ["only an equals sign", "="],
  ])("hostile: %s is kept as text", (_name, line) => {
    const v = viewLine(line, true);
    expect(v.text).toContain(line.slice(0, 3));
    expect(v.from).toBeGreaterThanOrEqual(0);
  });

  it("a 1 MiB line", () => {
    const line = `2026-11-14T09:14:02Z INFO ${"x".repeat(1 << 20)} k=v`;
    const t = performance.now();
    const v = viewLine(line, true);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(fields(v)).toEqual(["k=v"]);
  });
});
