import { describe, expect, it, vi } from "vitest";
import type { PullRequestFileView } from "@/api/prDiff";
import { COLLAPSE_OVER, oldFromNew, parsePrDiff, prFileLoader } from "./diffModel";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}\n`);
/** f.txt before: "line 1" … "line 30". */
const OLD = lines(30).join("");
/** After: a new first line, line 2 gone, line 15 changed, a line before 30, and a tail without a newline. */
const NEW = ["new top\n", ...lines(30).filter((l) => l !== "line 2\n")]
  .map((l) => (l === "line 15\n" ? "line fifteen\n" : l))
  .flatMap((l) => (l === "line 30\n" ? ["inserted\n", l] : [l]))
  .join("")
  .concat("tail");

// git diff --no-index -U3 of OLD and NEW.
const CHANGE = `diff --git a/f.txt b/f.txt
index ac9837c..34ad62d 100644
--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,5 @@
+new top
 line 1
-line 2
 line 3
 line 4
 line 5
@@ -12,7 +12,7 @@ line 11
 line 12
 line 13
 line 14
-line 15
+line fifteen
 line 16
 line 17
 line 18
@@ -27,4 +27,6 @@ line 26
 line 27
 line 28
 line 29
+inserted
 line 30
+tail
\\ No newline at end of file
`;

const OTHERS = `diff --git a/src/old/name.go b/src/new/name.go
similarity index 90%
rename from src/old/name.go
rename to src/new/name.go
index 3333333..4444444 100644
--- a/src/old/name.go
+++ b/src/new/name.go
@@ -5,0 +6 @@ func x() {
+	added()
diff --git a/same.md b/moved.md
similarity index 100%
rename from same.md
rename to moved.md
diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/img/logo.png differ
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 6666666..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`;

describe("parsePrDiff", () => {
  it("lists files with status, counts, binary and totals", () => {
    const m = parsePrDiff(CHANGE + OTHERS, "head");
    expect(m.files.map((f) => [f.status, f.dir, f.name, f.prevPath, f.added, f.deleted, f.binary])).toEqual([
      ["M", "", "f.txt", "", 4, 2, false],
      ["R", "src/new/", "name.go", "src/old/name.go", 1, 0, false],
      ["R", "", "moved.md", "same.md", 0, 0, false],
      ["A", "img/", "logo.png", "", 0, 0, true],
      ["D", "", "gone.txt", "", 0, 2, false],
    ]);
    expect(new Set(m.files.map((f) => f.id)).size).toBe(5);
    expect(m.added).toBe(5);
    expect(m.deleted).toBe(4);
    expect(m.files.every((f) => !f.collapsed)).toBe(true);
  });

  it("folds files with a long diff", () => {
    const n = COLLAPSE_OVER + 1;
    const big = `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${String(n)} @@\n${"+x\n".repeat(n)}`;
    const [file] = parsePrDiff(big, "").files;
    expect(file?.lines).toBe(n);
    expect(file?.collapsed).toBe(true);
  });

  it("reads an empty diff as no files", () => {
    expect(parsePrDiff("", "h")).toEqual({ files: [], added: 0, deleted: 0 });
  });
});

describe("oldFromNew", () => {
  const fd = () => {
    const f = parsePrDiff(CHANGE, "h").files[0];
    if (!f) throw new Error("no file");
    return f.fileDiff;
  };

  it("rebuilds the old side from the new side and the patch", () => {
    expect(oldFromNew(fd(), NEW)).toBe(OLD);
  });

  it("refuses a new side the patch was not made from", () => {
    expect(oldFromNew(fd(), NEW.replace("line 13\n", "line thirteen\n"))).toBeNull();
    expect(oldFromNew(fd(), NEW.slice(0, 40))).toBeNull();
    expect(oldFromNew(fd(), "")).toBeNull();
  });

  it("handles a pure insertion after a line", () => {
    const rename = parsePrDiff(OTHERS, "h").files[0];
    if (!rename) throw new Error("no file");
    const neu = "1\n2\n3\n4\n5\n\tadded()\n6\n";
    expect(oldFromNew(rename.fileDiff, neu)).toBe("1\n2\n3\n4\n5\n6\n");
  });
});

describe("prFileLoader", () => {
  const file = (o: Partial<PullRequestFileView>): PullRequestFileView => ({ contents: "", truncated: false, binary: false, notFound: false, ...o });

  it("reads the head side once and rebuilds the old one", async () => {
    const read = vi.fn(() => Promise.resolve(file({ contents: NEW })));
    const f = parsePrDiff(CHANGE, "h").files[0];
    if (!f) throw new Error("no file");
    const got = await prFileLoader("fork/r", "abc", read)(f.fileDiff);
    expect(read).toHaveBeenCalledExactlyOnceWith("fork/r", "abc", "f.txt");
    expect(got.oldFile?.contents).toBe(OLD);
    expect(got.newFile.contents).toBe(NEW);
  });

  it("gives a pure rename only its new side, and old side under the old name", async () => {
    const files = parsePrDiff(OTHERS, "h").files;
    const pure = files[1];
    const changed = files[0];
    if (!pure || !changed) throw new Error("no file");
    const pureGot = await prFileLoader("o/r", "abc", () => Promise.resolve(file({ contents: "x\n" })))(pure.fileDiff);
    expect(pureGot.oldFile).toBeNull();
    const changedGot = await prFileLoader("o/r", "abc", () => Promise.resolve(file({ contents: "1\n2\n3\n4\n5\n\tadded()\n" })))(changed.fileDiff);
    expect(changedGot.oldFile?.name).toBe("src/old/name.go");
  });

  it.each([
    [file({ notFound: true }), "not in the head commit"],
    [file({ binary: true }), "binary"],
    [file({ truncated: true, contents: NEW }), "over 1 MiB"],
    [file({ contents: "other\n" }), "does not match"],
  ])("refuses %#", async (res, why) => {
    const f = parsePrDiff(CHANGE, "h").files[0];
    if (!f) throw new Error("no file");
    await expect(prFileLoader("o/r", "abc", () => Promise.resolve(res))(f.fileDiff)).rejects.toThrow(why);
  });

  it("refuses without a head commit", async () => {
    const f = parsePrDiff(CHANGE, "h").files[0];
    if (!f) throw new Error("no file");
    await expect(prFileLoader("o/r", "", () => Promise.resolve(file({})))(f.fileDiff)).rejects.toThrow("head commit");
  });
});
