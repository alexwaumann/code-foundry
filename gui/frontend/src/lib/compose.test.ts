import { describe, expect, it } from "vitest";
import { checkAttachments, createdSessionId, pickDefault, MODEL_CHOICES, projectHue, projectInitials, sessionNewArgs, type DraftArgsInput } from "./compose";

const MB = 1024 * 1024;
const opts = { types: ["image/png", "image/jpeg"], maxBytes: 10 * MB };
const file = (name: string, type = "image/png", size = 1000) => ({ name, type, size });

describe("checkAttachments", () => {
  it.each([
    ["accepts images", [file("a.png"), file("b.jpg", "image/jpeg")], 0, ["a.png", "b.jpg"], []],
    ["rejects other types", [file("notes.txt", "text/plain")], 0, [], ["notes.txt: not a PNG, JPEG, GIF or WebP image"]],
    ["rejects files over the limit", [file("big.png", "image/png", 11 * MB)], 0, [], ["big.png: larger than 10 MB"]],
    ["names unnamed pastes", [file("", "image/svg+xml")], 0, [], ["pasted image: not a PNG, JPEG, GIF or WebP image"]],
    ["caps the count at 10 including existing ones", [file("a.png"), file("b.png"), file("c.png")], 9, ["a.png"], ["At most 10 images per thread; 2 not attached"]],
  ])("%s", (_name, files, existing, accepted, rejected) => {
    const res = checkAttachments(files, existing, opts);
    expect(res.accepted.map((f) => f.name)).toEqual(accepted);
    expect(res.rejected).toEqual(rejected);
  });
});

describe("sessionNewArgs", () => {
  const base: DraftArgsInput = { text: "  Add a dark mode toggle \n", model: "opus", effort: "high", permission: "auto", worktree: { kind: "new" }, base: "origin/main" };
  it.each<[string, Partial<DraftArgsInput>, string[], Record<string, string>]>([
    [
      "new worktree from a base, with attachments",
      {},
      ["/a/1.png", "/a/2.png"],
      { repo: "r", "new-worktree": "true", base: "origin/main", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle", attachments: "/a/1.png,/a/2.png" },
    ],
    ["new worktree without a known base lets the daemon pick", { base: "" }, [], { repo: "r", "new-worktree": "true", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle" }],
    [
      "existing worktree: its path, no base",
      { worktree: { kind: "existing", path: "/src/app" }, model: "", effort: "", text: "" },
      [],
      { repo: "r", worktree: "/src/app", permission: "auto" },
    ],
  ])("%s", (_name, over, staged, want) => {
    expect(sessionNewArgs("r", { ...base, ...over }, staged)).toEqual(want);
  });
});

describe("helpers", () => {
  it("createdSessionId reads the Session JSON", () => {
    expect(createdSessionId('{"id":"s-1a2b","worktreePath":"/x"}')).toBe("s-1a2b");
    expect(createdSessionId("")).toBeNull();
    expect(createdSessionId("not json")).toBeNull();
    expect(createdSessionId('{"name":"x"}')).toBeNull();
  });

  it("pickDefault uses a known setting, else the fallback", () => {
    expect(pickDefault(MODEL_CHOICES, "sonnet", "opus")).toBe("sonnet");
    expect(pickDefault(MODEL_CHOICES, "", "opus")).toBe("opus");
    expect(pickDefault(MODEL_CHOICES, undefined, "opus")).toBe("opus");
    expect(pickDefault(MODEL_CHOICES, "gpt", "opus")).toBe("opus");
  });

  it.each([
    ["code-foundry", "CF"],
    ["ghostty-playground", "GP"],
    ["dotfiles", "DO"],
    ["my app_v2", "MA"],
    ["", "?"],
  ])("projectInitials(%j) = %s", (name, want) => {
    expect(projectInitials(name)).toBe(want);
  });

  it("projectHue is stable and in range", () => {
    expect(projectHue("code-foundry")).toBe(projectHue("code-foundry"));
    for (const n of ["a", "code-foundry", "dotfiles", "x".repeat(200)]) {
      expect(projectHue(n)).toBeGreaterThanOrEqual(0);
      expect(projectHue(n)).toBeLessThan(360);
    }
  });
});
