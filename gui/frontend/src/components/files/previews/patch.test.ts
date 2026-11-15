import { afterEach, describe, expect, it, vi } from "vitest";
import { commitDate, decodeMimeWords, fileStarts, parsePatch, patchModelOf, sectionText, stripPatchPrefix } from "./patch";

const A = `diff --git a/src/a.ts b/src/a.ts
index 3f813da..a4a92c6 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
-two
+deux
+trois
 four
`;
const B = `diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..2ae608d
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+hello
+world
`;
const FORMAT_PATCH = `From a4a92c61b0aa1d2e3f4a5b6c7d8e9f0a1b2c3d4e Mon Sep 17 00:00:00 2001
From: Dev Person <dev@example.com>
Date: Fri, 13 Nov 2026 16:20:11 -0800
Subject: [PATCH 1/2] fix(gui): send a window's layout ops one at a time,
 in order

Posting them all at once let a later op land first.

Signed-off-by: Dev Person <dev@example.com>
---
 src/a.ts | 3 ++-
 src/b.ts | 2 ++
 2 files changed, 4 insertions(+), 1 deletion(-)

${A}${B}--
2.45.0

`;
const PLAIN = `--- old/main.c\t2026-11-13 10:00:00.000000000 +0100
+++ new/main.c\t2026-11-13 10:05:00.000000000 +0100
@@ -1,3 +1,3 @@
 #include <stdio.h>
--- a comment that looks like a header
+++ a line that looks like one too
 int main(void) {
`;

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parsePatch", () => {
  it("reads a format-patch file: its header and its files", () => {
    const m = parsePatch(FORMAT_PATCH);
    expect(m.commits).toHaveLength(1);
    expect(m.commits[0]?.header).toEqual({
      sha: "a4a92c61b0aa1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
      author: "Dev Person",
      date: "Fri, 13 Nov 2026 16:20:11 -0800",
      subject: "fix(gui): send a window's layout ops one at a time, in order",
      body: "Posting them all at once let a later op land first.\n\nSigned-off-by: Dev Person <dev@example.com>",
    });
    expect(m.files.map((f) => [f.path, f.status, f.added, f.deleted, f.note, f.problem])).toEqual([
      ["src/a.ts", "modified", 2, 1, null, null],
      ["src/b.ts", "added", 2, 0, null, null],
    ]);
    expect([m.added, m.deleted, m.problems]).toEqual([4, 1, 0]);
  });

  it("reads git diff output: no header", () => {
    const m = parsePatch(A + B);
    expect(m.commits).toHaveLength(1);
    expect(m.commits[0]?.header).toBeNull();
    expect(m.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reads a mailbox of several patches, each with its subject", () => {
    const second = FORMAT_PATCH.replace("a4a92c61b0aa1d2e3f4a5b6c7d8e9f0a1b2c3d4e", "1d276ed05aa1d2e3f4a5b6c7d8e9f0a1b2c3d4e").replace("[PATCH 1/2] fix(gui): send a window's layout ops one at a time,\n in order", "[PATCH 2/2] test: cover it");
    const m = parsePatch(FORMAT_PATCH + second);
    expect(m.commits.map((c) => c.header?.subject)).toEqual(["fix(gui): send a window's layout ops one at a time, in order", "test: cover it"]);
    expect(m.files).toHaveLength(4);
    expect(new Set(m.files.map((f) => f.id)).size).toBe(4);
  });

  it("reads git log -p output", () => {
    const log = `commit 2ae608d4e1a2b3c4d5e6f708192a3b4c5d6e7f80 (HEAD -> main)
Author: Dev Person <dev@example.com>
Date:   Fri Nov 13 16:20:11 2026 -0800

    feat: a thing

    Why it is.

${A}`;
    const m = parsePatch(log);
    expect(m.commits[0]?.header).toMatchObject({ sha: "2ae608d4e1a2b3c4d5e6f708192a3b4c5d6e7f80", author: "Dev Person", subject: "feat: a thing", body: "Why it is." });
    expect(m.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("reads a plain diff -u: one file, names as written, header-like lines inside a hunk", () => {
    const m = parsePatch(PLAIN);
    expect(m.files.map((f) => [f.path, f.prevPath, f.status, f.added, f.deleted, f.problem])).toEqual([["new/main.c", "", "modified", 1, 1, null]]);
  });

  it("reads diff -ruN: one section per file, /dev/null for the side that is not there", () => {
    const text = `diff -ruN a/x.txt b/x.txt
--- a/x.txt\t2026-11-13
+++ b/x.txt\t2026-11-13
@@ -1 +1 @@
-x
+y
Only in a: gone.txt
diff -ruN a/new.txt b/new.txt
--- a/new.txt\t1970-01-01
+++ /dev/null\t2026-11-13
@@ -1 +0,0 @@
-bye
diff -ruN a/born.txt b/born.txt
--- /dev/null\t1970-01-01
+++ b/born.txt\t2026-11-13
@@ -0,0 +1 @@
+hi
`;
    const m = parsePatch(text);
    expect(m.files.map((f) => [f.path, f.status, f.added, f.deleted, f.problem])).toEqual([
      ["b/x.txt", "modified", 1, 1, null],
      ["a/new.txt", "deleted", 0, 1, null],
      ["b/born.txt", "added", 1, 0, null],
    ]);
  });

  it.each([
    [
      "a pure rename",
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
      { path: "new.ts", prevPath: "old.ts", status: "renamed", note: "Contents unchanged" },
    ],
    [
      "a rename with changes",
      "diff --git a/old.ts b/new.ts\nsimilarity index 80%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n",
      { path: "new.ts", prevPath: "old.ts", status: "renamed", note: null, added: 1, deleted: 1 },
    ],
    ["a copy", "diff --git a/a.ts b/c.ts\nsimilarity index 100%\ncopy from a.ts\ncopy to c.ts\n", { path: "c.ts", prevPath: "a.ts", status: "copied", note: "Contents unchanged" }],
    ["a binary change", "diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n", { path: "logo.png", binary: true, note: "Binary file" }],
    [
      "a binary patch",
      "diff --git a/i.png b/i.png\nnew file mode 100644\nindex 0000000..3333333\nGIT binary patch\nliteral 4\nLcmZ?wbhEHbZ~^1HVQ\n\nliteral 0\nHcmV?d00001\n\n",
      { path: "i.png", status: "added", binary: true, note: "Binary file" },
    ],
    ["a mode change only", "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n", { path: "run.sh", mode: { from: "100644", to: "100755" }, note: "Mode 100644 → 100755" }],
    ["a deleted file", "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 4444444..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n", { path: "gone.ts", status: "deleted", deleted: 2, note: null }],
    ["an empty new file", "diff --git a/empty b/empty\nnew file mode 100644\nindex 0000000..e69de29\n", { path: "empty", status: "added", note: "Empty file" }],
  ])("%s", (_, text, want) => {
    const m = parsePatch(text);
    expect(m.files).toHaveLength(1);
    expect(m.files[0]).toMatchObject({ problem: null, ...want });
  });

  it.each([
    ["empty", ""],
    ["blank lines", "\n\n"],
    ["prose", "Just some notes,\nnot a diff at all.\n"],
  ])("finds no files in %s", (_, text) => {
    const m = parsePatch(text);
    expect(m.files).toEqual([]);
    expect(m.commits).toEqual([]);
  });

  it("keeps a format-patch cover letter with no files as a commit", () => {
    const m = parsePatch("From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: A <a@x>\nSubject: [PATCH 0/2] the series\n\nIt does things.\n");
    expect(m.commits).toEqual([{ header: expect.objectContaining({ subject: "the series", body: "It does things." }) as unknown, files: [] }]);
  });

  it("flags a hunk cut short and shows what parsed", () => {
    quiet();
    const cut = A + B.split("\n").slice(0, -2).join("\n") + "\n";
    const m = parsePatch(cut);
    expect(m.files.map((f) => [f.path, f.problem === null])).toEqual([
      ["src/a.ts", true],
      ["src/b.ts", false],
    ]);
    expect(m.files[1]?.problem).toMatch(/count|lines/);
    expect(m.files[1]?.added).toBe(1);
    expect(m.problems).toBe(1);
  });

  it("flags a git section with nothing after its header", () => {
    quiet();
    const m = parsePatch("diff --git a/x b/x\nindex 1..2 100644\n");
    expect(m.files[0]).toMatchObject({ path: "x", note: "Nothing here parses as a diff" });
    expect(m.files[0]?.problem).not.toBeNull();
  });

  it("reads CRLF line ends", () => {
    const m = parsePatch(A.replace(/\n/g, "\r\n"));
    expect(m.files.map((f) => [f.path, f.added, f.deleted, f.problem])).toEqual([["src/a.ts", 2, 1, null]]);
  });

  it("remembers the last text's model", () => {
    const text = A + B;
    expect(patchModelOf(text)).toBe(patchModelOf(text));
  });
});

describe("fileStarts", () => {
  it.each([
    ["git: at each diff --git", (A + B).split("\n"), [0, 10]],
    ["plain: a removed line that reads like a header is not a file", PLAIN.split("\n"), [0]],
    ["plain with a diff command above the header", "diff -u a b\n--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n".split("\n"), [0]],
  ])("%s", (_, lines, want) => {
    expect(fileStarts(lines)).toEqual(want);
  });
});

describe("header text", () => {
  it.each([
    ["[PATCH] fix: x", "fix: x"],
    ["[PATCH 2/7] fix: x", "fix: x"],
    ["[PATCH v3 02/10] fix: x", "fix: x"],
    ["[RFC PATCH] fix: x", "fix: x"],
    ["[gui] fix: x", "[gui] fix: x"],
  ])("stripPatchPrefix(%j)", (s, want) => {
    expect(stripPatchPrefix(s)).toBe(want);
  });

  it.each([
    ["plain", "plain"],
    ["=?UTF-8?q?Ren=C3=A9e_Dupont?=", "Renée Dupont"],
    ["=?UTF-8?b?UmVuw6ll?=", "Renée"],
    ["=?UTF-8?q?caf=C3=A9?= =?UTF-8?q?_au_lait?=", "café au lait"],
    ["=?bogus-charset?q?x?=", "=?bogus-charset?q?x?="],
  ])("decodeMimeWords(%j)", (s, want) => {
    expect(decodeMimeWords(s)).toBe(want);
  });

  it.each([
    ["Fri, 13 Nov 2026 16:20:11 -0800", /Nov 1[34], 2026/],
    ["not a date", /^not a date$/],
    ["", /^$/],
  ])("commitDate(%j)", (raw, want) => {
    expect(commitDate(raw)).toMatch(want);
  });
});

describe("sectionText", () => {
  it.each([
    ["an empty line inside a hunk is context", "--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n\n-y\n+z\n", "--- a\n+++ b\n@@ -1,3 +1,3 @@\n x\n \n-y\n+z\n"],
    ["format-patch's signature is left out", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n-- \n2.47.1\n", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n"],
    ["a stripped signature too", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n--\n2.47.1\n", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n"],
    ["diff -r's notes after the last hunk", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\nOnly in a: q\n", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n"],
    ["extra hunk lines stay, for the library to flag", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n+w\n", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n+z\n+w\n"],
    ["no newline at end", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n\\ No newline at end of file\n+z\n", "--- a\n+++ b\n@@ -1 +1 @@\n-y\n\\ No newline at end of file\n+z\n"],
  ])("%s", (_, text, want) => {
    const lines = text.split("\n").slice(0, -1);
    expect(sectionText(lines, 0, lines.length)).toBe(want);
  });

  it("parses a patch whose blank context lines lost their space, without a problem", () => {
    const m = parsePatch(FORMAT_PATCH.replace(/^ $/gm, "").replace("-- \n", "--\n"));
    expect(m.problems).toBe(0);
    expect([m.added, m.deleted]).toEqual([4, 1]);
  });
});
