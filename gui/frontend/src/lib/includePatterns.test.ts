import { describe, expect, it } from "vitest";
import {
  effectivePatterns,
  fileCount,
  formatPatterns,
  missingDefaults,
  parseIncludeSetting,
  patternErrorText,
  restoreDefaults,
  restoreLabel,
  suggestionPattern,
  typedPattern,
  withoutPattern,
  withPattern,
} from "./includePatterns";

const DEFAULTS = [".env*", "CLAUDE.local.md", ".claude/settings.local.json"];

describe("parseIncludeSetting", () => {
  it.each([
    ["the default value", ".env*, CLAUDE.local.md, .claude/settings.local.json", DEFAULTS],
    ["none is empty", "none", []],
    ["None in any case, padded", "  NONE ", []],
    ["blanks and repeats dropped, trimmed", " a/ ,, b ,a/,", ["a/", "b"]],
    ["one pattern", "scratch/", ["scratch/"]],
  ])("%s", (_, value, want) => {
    expect(parseIncludeSetting(value)).toEqual(want);
  });
});

describe("formatPatterns", () => {
  it("joins with a comma and a space; the empty list is none (an empty value would bring the defaults back)", () => {
    expect(formatPatterns(["a", "b/"])).toBe("a, b/");
    expect(formatPatterns([])).toBe("none");
    expect(parseIncludeSetting(formatPatterns([]))).toEqual([]);
  });
});

describe("restoring defaults", () => {
  it.each([
    ["nothing missing", DEFAULTS, [], DEFAULTS],
    ["one removed, user patterns added", [".env*", ".claude/settings.local.json", "*.local.json", "scratch/"], ["CLAUDE.local.md"], [".env*", ".claude/settings.local.json", "*.local.json", "scratch/", "CLAUDE.local.md"]],
    ["all removed (none)", [], DEFAULTS, DEFAULTS],
    ["only the user's own", ["scratch/"], DEFAULTS, ["scratch/", ...DEFAULTS]],
  ])("%s", (_, list, missing, restored) => {
    expect(missingDefaults(list, DEFAULTS)).toEqual(missing);
    const next = restoreDefaults(list, DEFAULTS);
    expect(next).toEqual(restored);
    // The user's own patterns survive, in place.
    expect(next.slice(0, list.length)).toEqual(list);
    expect(missingDefaults(next, DEFAULTS)).toEqual([]);
  });

  it("labels the link by count", () => {
    expect(restoreLabel(1)).toBe("Restore 1 default");
    expect(restoreLabel(3)).toBe("Restore 3 defaults");
  });
});

describe("editing a list", () => {
  it("removes one; removing the last leaves the empty list (stored as none)", () => {
    expect(withoutPattern(["a", "b"], "a")).toEqual(["b"]);
    expect(formatPatterns(withoutPattern(["a"], "a"))).toBe("none");
  });

  it("adds at the end; a pattern already there leaves the same list", () => {
    const list = ["a"];
    expect(withPattern(list, "b")).toEqual(["a", "b"]);
    expect(withPattern(list, "a")).toBe(list);
  });
});

describe("typedPattern", () => {
  it.each([
    ["  scratch/ ", "scratch/", ""],
    ["", "", ""],
    ["   ", "", ""],
    ["a, b", "a, b", 'pattern "a, b" has a comma, which separates patterns'],
  ])("%j", (text, pattern, error) => {
    expect(typedPattern(text)).toEqual({ pattern, error });
  });
});

describe("effectivePatterns", () => {
  it("the setting's first (all projects), then the project's own; a repeat is listed once, where it comes first", () => {
    expect(effectivePatterns([".env*", "CLAUDE.local.md"], ["docs/scratch/", ".env*"])).toEqual([
      { pattern: ".env*", scope: "all" },
      { pattern: "CLAUDE.local.md", scope: "all" },
      { pattern: "docs/scratch/", scope: "project" },
    ]);
    expect(effectivePatterns([], [])).toEqual([]);
  });
});

describe("suggestions and counts", () => {
  it("a folder is added with a trailing slash, a file as is", () => {
    expect(suggestionPattern({ path: "gui/frontend/test-results", isDir: true })).toBe("gui/frontend/test-results/");
    expect(suggestionPattern({ path: ".env.local", isDir: false })).toBe(".env.local");
  });

  it.each([
    [1, false, "1 file"],
    [0, false, "0 files"],
    [212, false, "212 files"],
    [1000, true, "1,000+ files"],
    [1, true, "1+ files"],
  ])("fileCount(%d, %s)", (n, capped, want) => {
    expect(fileCount(n, capped)).toBe(want);
  });

  it("drops the invalid argument prefix from the daemon's message", () => {
    expect(patternErrorText('invalid argument: pattern "../x" has a ".." segment; patterns name paths inside the project')).toBe('pattern "../x" has a ".." segment; patterns name paths inside the project');
    expect(patternErrorText("daemon unreachable")).toBe("daemon unreachable");
  });
});
