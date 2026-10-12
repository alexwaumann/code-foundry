import { describe, expect, it } from "vitest";
import { encodeTagPath, projectPrompt, tagToken } from "./prompt";
import { inlineImagePaths, parseUserMessage } from "./userMessage";

describe("parseUserMessage", () => {
  it("reads back what the composer projected: images, files, skills", () => {
    const draft = `The badge is stale, see ${tagToken({ tagKind: "image", id: "a1", name: "pr-badge-stale.png" })} Look at ${tagToken({ tagKind: "file", repoId: "repo-cf", path: "internal/store/pr/poller.go" })} and fix it with ${tagToken({ tagKind: "skill", name: "tdd", repoId: "" })}. Keep it.`;
    const sent = projectPrompt(draft, (id) => (id === "a1" ? { name: "pr-badge-stale.png", ref: "/att/0a.png" } : undefined));
    expect(parseUserMessage(sent)).toEqual([
      { kind: "text", text: "The badge is stale, see " },
      { kind: "image", name: "pr-badge-stale.png", path: "/att/0a.png" },
      { kind: "text", text: " Look at " },
      { kind: "file", repoId: "repo-cf", path: "internal/store/pr/poller.go" },
      { kind: "text", text: " and fix it with " },
      { kind: "skill", name: "tdd" },
      { kind: "text", text: " . Keep it." },
    ]);
  });

  it("decodes file paths and keeps directories", () => {
    const path = "docs/a b#%.md";
    expect(parseUserMessage(`@cf-file://r1/${encodeTagPath(path)} and @cf-file://r1/src/`)).toEqual([
      { kind: "file", repoId: "r1", path },
      { kind: "text", text: " and " },
      { kind: "file", repoId: "r1", path: "src/" },
    ]);
    expect(parseUserMessage("@cf-file://r1/%E0%A4%A")).toEqual([{ kind: "text", text: "@cf-file://r1/%E0%A4%A" }]);
  });

  it.each([
    ["/review now", [{ kind: "skill", name: "review" }, { kind: "text", text: " now" }]],
    ["use /plugin:deploy", [{ kind: "text", text: "use " }, { kind: "skill", name: "plugin:deploy" }]],
    ["see /tmp/x and a/b and /1abc", [{ kind: "text", text: "see /tmp/x and a/b and /1abc" }]],
    ["x/review", [{ kind: "text", text: "x/review" }]],
  ])("skills by shape: %j", (text, want) => {
    expect(parseUserMessage(text)).toEqual(want);
  });

  it("an image chip whose attachment was gone has no path", () => {
    const pieces = parseUserMessage("[Image: shot.png] and [Image: b.png; ref=/att/b.png]");
    expect(pieces[0]).toEqual({ kind: "image", name: "shot.png", path: "" });
    expect([...inlineImagePaths(pieces)]).toEqual(["/att/b.png"]);
  });
});
