import { describe, expect, it } from "vitest";
import { tagToken } from "./prompt";
import { inlineAttachmentPaths, parseUserMessage, sentComposerText } from "./userMessage";

const image = (id: string, name: string) => tagToken({ tagKind: "image", id, name });
const file = (projectId: string, path: string) => tagToken({ tagKind: "file", projectId, path });
const skill = (name: string, projectId = "") => tagToken({ tagKind: "skill", name, projectId });

describe("sentComposerText", () => {
  it("replaces image chip ids with their attachment index, keeps other tags", () => {
    const draft = `see ${image("a7", "b.png")} and ${image("a3", "a.png")} in ${file("r1", "src/x.go")} with ${skill("tdd")}\n${image("gone", "c.png")}`;
    const order = ["a3", "a7"];
    const out = sentComposerText(draft, (id) => (order.includes(id) ? order.indexOf(id) : undefined));
    expect(out).toBe(`see ${image("1", "b.png")} and ${image("0", "a.png")} in ${file("r1", "src/x.go")} with ${skill("tdd")}\n${image("x", "c.png")}`);
  });
});

describe("parseUserMessage", () => {
  it("draws tags from the composer's tokens", () => {
    const composer = `The badge is stale, see ${image("0", "pr-badge-stale.png")} Look at ${file("repo-cf", "internal/store/pr/poller.go")} and fix it with ${skill("tdd")}. Keep it.`;
    expect(parseUserMessage("(projected)", composer, ["/att/0a.png"])).toEqual([
      { kind: "text", text: "The badge is stale, see " },
      { kind: "image", name: "pr-badge-stale.png", path: "/att/0a.png" },
      { kind: "text", text: " Look at " },
      { kind: "file", projectId: "repo-cf", path: "internal/store/pr/poller.go" },
      { kind: "text", text: " and fix it with " },
      { kind: "skill", name: "tdd" },
      { kind: "text", text: ". Keep it." },
    ]);
  });

  it("draws thread and pull request tags from the composer's tokens, not from the projected text", () => {
    const thread = tagToken({ tagKind: "thread", id: "s-0123456789ab", name: "Fix resize race" });
    const pr = tagToken({ tagKind: "pr", slug: "alexwaumann/code-foundry", number: 185 });
    const projected = 'see [Thread "Fix resize race" (id s-0123456789ab)] and alexwaumann/code-foundry#185';
    expect(parseUserMessage(projected, `see ${thread} and ${pr}`, [])).toEqual([
      { kind: "text", text: "see " },
      { kind: "thread", id: "s-0123456789ab", name: "Fix resize race" },
      { kind: "text", text: " and " },
      { kind: "pr", slug: "alexwaumann/code-foundry", number: 185 },
    ]);
    // A message sent without the composer's text (the CLI) stays text.
    expect(parseUserMessage(projected, "", [])).toEqual([{ kind: "text", text: projected }]);
    // sentComposerText keeps both tokens as they are.
    expect(sentComposerText(`${thread} ${pr}`, () => undefined)).toBe(`${thread} ${pr}`);
  });

  it("decodes file paths, keeps directories and lines", () => {
    const path = "docs/a b#%.md";
    expect(parseUserMessage("", `${file("r1", path)} and\n${file("r1", "src/")}`, [])).toEqual([
      { kind: "file", projectId: "r1", path },
      { kind: "text", text: " and\n" },
      { kind: "file", projectId: "r1", path: "src/" },
    ]);
  });

  it("never guesses tags from the projected text", () => {
    expect(parseUserMessage("ls /tmp then /review @cf-file://r1/a.go [Image: a.png; ref=/att/a.png]", "", ["/att/a.png"])).toEqual([
      { kind: "text", text: "ls /tmp then /review @cf-file://r1/a.go [Image: a.png; ref=/att/a.png]" },
    ]);
    expect(parseUserMessage("ls /tmp", "ls /tmp", [])).toEqual([{ kind: "text", text: "ls /tmp" }]);
    expect(parseUserMessage("", "", [])).toEqual([]);
  });

  it("an image chip whose attachment was gone has no path", () => {
    const pieces = parseUserMessage("", `${image("x", "shot.png")} and ${image("1", "b.png")} ${image("5", "c.png")}`, ["/att/a.png", "/att/b.png"]);
    expect(pieces[0]).toEqual({ kind: "image", name: "shot.png", path: "" });
    expect(pieces[4]).toEqual({ kind: "image", name: "c.png", path: "" });
    expect([...inlineAttachmentPaths(pieces)]).toEqual(["/att/b.png"]);
  });

  it.each<[string, string, string, "image" | "pdf"]>([
    ["an image", "drop me here.png", "/att/9d08.png", "image"],
    ["a PDF", "my report (1).pdf", "/att/0a1b-2p.pdf", "pdf"],
    ["a macOS screenshot (U+202F before AM)", "Screenshot 2026-10-18 at 10.42.13\u202fAM.png", "/att/c3.png", "image"],
  ])("%s chip whose name has spaces keeps its name and staged path", (_name, name, staged, kind) => {
    const sent = sentComposerText(`Look at ${image("d1", name)} please`, (id) => (id === "d1" ? 0 : undefined));
    const pieces = parseUserMessage("(projected)", sent, [staged]);
    expect(pieces).toEqual([{ kind: "text", text: "Look at " }, { kind, name, path: staged }, { kind: "text", text: " please" }]);
    expect([...inlineAttachmentPaths(pieces)]).toEqual([staged]);
  });

  it("a chip whose staged file is a PDF (Claude got [PDF: …]) is a pdf piece", () => {
    const composer = `Summarize ${image("0", "spec.pdf")} next to ${image("1", "shot.png")} and ${image("x", "gone.pdf")}`;
    const sent = sentComposerText(composer.replace("](cf-attachment://0)", "](cf-attachment://p1)"), (id) => (id === "p1" ? 0 : undefined));
    expect(sent).toBe(`Summarize ${image("0", "spec.pdf")} next to ${image("x", "shot.png")} and ${image("x", "gone.pdf")}`);
    const pieces = parseUserMessage("(projected)", composer, ["/att/0a.pdf", "/att/1b.png"]);
    expect(pieces.filter((p) => p.kind !== "text")).toEqual([
      { kind: "pdf", name: "spec.pdf", path: "/att/0a.pdf" },
      { kind: "image", name: "shot.png", path: "/att/1b.png" },
      { kind: "pdf", name: "gone.pdf", path: "" },
    ]);
    expect([...inlineAttachmentPaths(pieces)]).toEqual(["/att/0a.pdf", "/att/1b.png"]);
  });
});
