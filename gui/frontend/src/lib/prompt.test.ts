import { describe, expect, it } from "vitest";
import {
  chipInsertText,
  chipToken,
  formatAttachmentSize,
  isReferenced,
  kindFromName,
  middleTruncate,
  parsePrompt,
  projectPrompt,
  proseOf,
  referencedIds,
  parseLine,
  removeReferences,
  removeRepoTags,
  repoTagCount,
  retainRepoTags,
  serializePrompt,
  tagLabel,
  tagsByRepo,
  tagToken,
  type PromptTag,
} from "./prompt";

const A = chipToken("a1", "shot.png");
const B = chipToken("a2", "logo.webp");

describe("prompt tokens", () => {
  it("round-trips text with chips across lines", () => {
    const text = `Compare ${A} with\n\n${B} and ${A}`;
    const lines = parsePrompt(text);
    expect(lines).toEqual([
      [{ kind: "text", text: "Compare " }, { kind: "tag", tagKind: "image", id: "a1", name: "shot.png" }, { kind: "text", text: " with" }],
      [],
      [{ kind: "tag", tagKind: "image", id: "a2", name: "logo.webp" }, { kind: "text", text: " and " }, { kind: "tag", tagKind: "image", id: "a1", name: "shot.png" }],
    ]);
    expect(serializePrompt(lines)).toBe(text);
    expect(referencedIds(text)).toEqual(["a1", "a2"]);
    expect(isReferenced(text, "a2")).toBe(true);
    expect(isReferenced(text, "a3")).toBe(false);
    expect(proseOf(text)).toBe("Compare  with\n\n and ");
  });

  it("cleans labels that would break the token", () => {
    expect(chipToken("a1", "we[ir]d;\nname.png")).toBe("![we ir d name.png](cf-attachment://a1)");
    expect(chipToken("a1", "")).toBe("![image](cf-attachment://a1)");
  });

  it.each([
    ["the following space goes with it", `Look ${A} here`, "Look here"],
    ["else the preceding one", `Look at ${A}`, "Look at"],
    ["every occurrence", `${A} and ${A} and ${B}`, `and and ${B}`],
    ["trailing whitespace is trimmed", `Fix ${A} \n`, "Fix"],
    ["other text is untouched", `Fix ${B}`, `Fix ${B}`],
  ])("removeReferences: %s", (_name, text, want) => {
    expect(removeReferences(text, "a1")).toBe(want);
  });

  it("projects chips to [Image: name; ref=path] at their position", () => {
    const text = `Match ${A} and ${B}\nthanks`;
    const staged: Record<string, { name: string; ref: string; kind: "image" | "pdf" }> = { a1: { name: "shot.png", ref: "/att/1.png", kind: "image" } };
    expect(projectPrompt(text, (id) => staged[id])).toBe("Match [Image: shot.png; ref=/att/1.png] and [Image: logo.webp]\nthanks");
  });

  it("projects PDF chips to [PDF: name; ref=path]; a gone one by its name", () => {
    const spec = chipToken("p1", "spec.pdf");
    const gone = chipToken("p9", "old.PDF");
    const staged: Record<string, { name: string; ref: string; kind: "image" | "pdf" }> = { p1: { name: "spec.pdf", ref: "/att/2.pdf", kind: "pdf" } };
    expect(projectPrompt(`Read ${spec} then ${gone}`, (id) => staged[id])).toBe("Read [PDF: spec.pdf; ref=/att/2.pdf] then [PDF: old.PDF]");
    expect(kindFromName("notes.pdf ")).toBe("pdf");
    expect(kindFromName("shot.png")).toBe("image");
  });
});

describe("chip presentation", () => {
  it.each([
    [0, "1 KB"],
    [300, "1 KB"],
    [58 * 1024, "58 KB"],
    [58 * 1024 + 1, "59 KB"],
    [1024 * 1024, "1.0 MB"],
    [1.44 * 1024 * 1024, "1.4 MB"],
  ])("formatAttachmentSize(%d) = %s", (bytes, want) => {
    expect(formatAttachmentSize(bytes)).toBe(want);
  });

  it("middle-truncates long names keeping the end", () => {
    expect(middleTruncate("image.png")).toBe("image.png");
    const long = "Screenshot 2026-10-09 at 14.31.07 (2).png";
    const t = middleTruncate(long);
    expect(Array.from(t)).toHaveLength(36);
    expect(t.endsWith(" 14.31.07 (2).png".slice(-14))).toBe(true);
    expect(t).toContain("…");
  });
});

describe("chipInsertText", () => {
  it.each<[string, string[], string, { hasProse: boolean; replacingSelection: boolean }, string | null]>([
    ["nothing into an empty prompt", [A], "", { hasProse: false, replacingSelection: false }, null],
    ["a replaced selection gets one even without prose", [A], "", { hasProse: false, replacingSelection: true }, `${A} `],
    ["a leading space after a word", [A], "Fix", { hasProse: true, replacingSelection: false }, ` ${A} `],
    ["no leading space after whitespace", [A], "Fix ", { hasProse: true, replacingSelection: false }, `${A} `],
    ["several joined by spaces", [A, B], "", { hasProse: true, replacingSelection: false }, `${A} ${B} `],
    ["none to insert", [], "x", { hasProse: true, replacingSelection: false }, null],
  ])("%s", (_name, tokens, before, opts, want) => {
    expect(chipInsertText(tokens, before, opts)).toBe(want);
  });
});

const DEPLOY = tagToken({ tagKind: "skill", name: "deploy", repoId: "r1" });
const COMMIT = tagToken({ tagKind: "skill", name: "commit", repoId: "" });
const API_DEPLOY = tagToken({ tagKind: "skill", name: "deploy", repoId: "r2" });
const FILE = tagToken({ tagKind: "file", repoId: "r1", path: "src/my notes (1).md" });
const DIR = tagToken({ tagKind: "file", repoId: "r2", path: "src/components/" });

describe("skill and file tags", () => {
  it("writes the documented tokens", () => {
    expect(DEPLOY).toBe("[/deploy](cf-skill://r1/deploy)");
    expect(COMMIT).toBe("[/commit](cf-skill://~/commit)");
    expect(FILE).toBe("[my notes (1).md](cf-file://r1/src/my%20notes%20%281%29.md)");
    expect(DIR).toBe("[components/](cf-file://r2/src/components/)");
  });

  it("round-trips every kind on one line", () => {
    const text = `Run ${DEPLOY} then ${COMMIT} on ${FILE} and ${DIR}, see ${A}`;
    const [line = []] = parsePrompt(text);
    expect(line.filter((p) => p.kind === "tag")).toEqual([
      { kind: "tag", tagKind: "skill", name: "deploy", repoId: "r1" },
      { kind: "tag", tagKind: "skill", name: "commit", repoId: "" },
      { kind: "tag", tagKind: "file", repoId: "r1", path: "src/my notes (1).md" },
      { kind: "tag", tagKind: "file", repoId: "r2", path: "src/components/" },
      { kind: "tag", tagKind: "image", id: "a1", name: "shot.png" },
    ]);
    expect(serializePrompt([line])).toBe(text);
    expect(referencedIds(text)).toEqual(["a1"]);
    // Skill and file tags count as prose for chipInsertText; only images do not.
    expect(proseOf(text)).toBe(`Run ${DEPLOY} then ${COMMIT} on ${FILE} and ${DIR}, see `);
  });

  it.each<[string, PromptTag, string]>([
    ["a skill", { tagKind: "skill", name: "deploy", repoId: "r1" }, "/deploy"],
    ["a file", { tagKind: "file", repoId: "r1", path: "src/a/Composer.tsx" }, "Composer.tsx"],
    ["a top-level file", { tagKind: "file", repoId: "r1", path: "README.md" }, "README.md"],
    ["a directory", { tagKind: "file", repoId: "r1", path: "src/components/" }, "components/"],
    ["an image", { tagKind: "image", id: "a1", name: "x[1].png" }, "x 1 .png"],
  ])("tagLabel: %s", (_name, tag, want) => {
    expect(tagLabel(tag)).toBe(want);
  });

  it.each<[string, string, PromptTag]>([
    ["the label is not trusted", "[/evil](cf-skill://r1/deploy)", { tagKind: "skill", name: "deploy", repoId: "r1" }],
    ["a skill name is decoded", "[/a b](cf-skill://~/a%20b)", { tagKind: "skill", name: "a b", repoId: "" }],
  ])("parses: %s", (_name, token, want) => {
    expect(parseLine(token)).toEqual([{ kind: "tag", ...want }]);
  });

  it.each([
    ["a bad escape", "[x](cf-file://r1/a%zz)"],
    ["a skill with a slash", "[/a](cf-skill://r1/a%2Fb)"],
    ["a user-scope file", "[a](cf-file://~/a.md)"],
    ["an unknown scheme", "[a](cf-thing://r1/a)"],
    ["no repo slot", "[/a](cf-skill:///a)"],
  ])("leaves malformed tokens as text: %s", (_name, token) => {
    expect(parseLine(token)).toEqual([{ kind: "text", text: token }]);
  });

  it.each([
    ["before a skill", `see [x ${DEPLOY}`, "see [x ", "see [x /deploy", "see [x"],
    ["before a file", `a[i ${FILE} b`, "a[i ", "a[i @cf-file://r1/src/my%20notes%20%281%29.md b", "a[i b"],
    ["before an image", `![ ${A}`, "![ ", "![ [Image: shot.png]", `![ ${A}`],
  ])("an unclosed [ typed %s stays text", (_name, text, lead, sent, removed) => {
    const [line = []] = parsePrompt(text);
    expect(line[0]).toEqual({ kind: "text", text: lead });
    expect(line.filter((p) => p.kind === "tag")).toHaveLength(1);
    expect(serializePrompt([line])).toBe(text);
    expect(projectPrompt(text, () => undefined)).toBe(sent);
    expect(removeRepoTags(text, "r1")).toBe(removed);
  });

  it("projects skills to /name and files to @cf-file://, each followed by whitespace", () => {
    const staged: Record<string, { name: string; ref: string; kind: "image" | "pdf" }> = { a1: { name: "shot.png", ref: "/att/1.png", kind: "image" } };
    expect(projectPrompt(`${DEPLOY} now, ${COMMIT}\n${FILE}${DIR}. ${A}`, (id) => staged[id])).toBe(
      "/deploy now, /commit\n@cf-file://r1/src/my%20notes%20%281%29.md @cf-file://r2/src/components/ . [Image: shot.png; ref=/att/1.png]",
    );
    expect(projectPrompt(`${DEPLOY} `, () => undefined)).toBe("/deploy ");
  });

  // The daemon ends a reference at whitespace and decodes it with url.PathUnescape
  // (internal/store/thread/filerefs.go); decodeURIComponent agrees with it on these.
  it.each<[string, string, string]>([
    ["# and %", "docs/#1 50%.md", "docs/%231%2050%25.md"],
    ["unicode", "src/naïve/日本.ts", "src/na%C3%AFve/%E6%97%A5%E6%9C%AC.ts"],
    ["+ and ~", "a+b/~x.md", "a%2Bb/~x.md"],
    ["a no-break space", "nb\u00a0sp.md", "nb%C2%A0sp.md"],
    ["!'()* and brackets", "odd!'()*[x].md", "odd%21%27%28%29%2A%5Bx%5D.md"],
    ["a directory with a space", "my dir/", "my%20dir/"],
  ])("a file path round-trips through the token and the projection: %s", (_name, path, encoded) => {
    const tag: PromptTag = { tagKind: "file", repoId: "r1", path };
    const token = tagToken(tag);
    expect(token.endsWith(`](cf-file://r1/${encoded})`)).toBe(true);
    expect(parseLine(token)).toEqual([{ kind: "tag", ...tag }]);
    const sent = projectPrompt(`${token}x`, () => undefined);
    expect(sent).toBe(`@cf-file://r1/${encoded} x`);
    const ref = sent.split(/\s/u)[0] ?? "";
    expect(decodeURIComponent(ref.slice("@cf-file://r1/".length))).toBe(path);
  });

  it("tagsByRepo and repoTagCount see project skills and files only", () => {
    const text = `${COMMIT} ${API_DEPLOY} ${DEPLOY} ${A} ${FILE}\n${DIR}`;
    expect(tagsByRepo(text)).toEqual(["r2", "r1"]);
    expect(repoTagCount(text, "r1")).toBe(2);
    expect(repoTagCount(text, "r2")).toBe(2);
    expect(repoTagCount(text, "r3")).toBe(0);
    expect(tagsByRepo(`${COMMIT} ${A}`)).toEqual([]);
  });

  it.each([
    ["the following space goes with each", `Use ${API_DEPLOY} and ${DIR} here`, "Use and here"],
    ["else the preceding one", `Look at ${DIR}`, "Look at"],
    ["other repos, user skills and images stay", `${DEPLOY} ${API_DEPLOY} ${COMMIT} ${A}`, `${DEPLOY} ${COMMIT} ${A}`],
    ["nothing of the repo: unchanged", `Fix ${DEPLOY} `, `Fix ${DEPLOY} `],
  ])("removeRepoTags: %s", (_name, text, want) => {
    expect(removeRepoTags(text, "r2")).toBe(want);
  });

  it("retainRepoTags keeps the listed repos' tags, images and user skills", () => {
    const text = `${DEPLOY} ${API_DEPLOY} ${COMMIT} ${FILE} ${A}`;
    expect(retainRepoTags(text, ["r1"])).toBe(`${DEPLOY} ${COMMIT} ${FILE} ${A}`);
    expect(retainRepoTags(text, [])).toBe(`${COMMIT} ${A}`);
    expect(retainRepoTags(text, ["r1", "r2"])).toBe(text);
  });

  it("removeReferences leaves skill and file tags alone", () => {
    expect(removeReferences(`${DEPLOY} ${A} ${FILE}`, "a1")).toBe(`${DEPLOY} ${FILE}`);
  });
});
