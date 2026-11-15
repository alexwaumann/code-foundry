/**
 * The patch preview's mock files (docs/notes/file-previews-5-patch.md): a format-patch with
 * two files, a mailbox of two commits, a plain `diff -u`, a rename with a binary and a mode
 * change, a cut-short diff, a `.diff` that is not one, and a generated large patch. Under
 * the code-foundry fixture checkout's `docs/patches/`, with the daemon's mime (text/x-diff).
 */

const LAYOUT = `diff --git a/gui/frontend/src/stores/layout.ts b/gui/frontend/src/stores/layout.ts
index 3f813da..a4a92c6 100644
--- a/gui/frontend/src/stores/layout.ts
+++ b/gui/frontend/src/stores/layout.ts
@@ -41,9 +41,18 @@ export function sendOp(win: string, op: LayoutOp): string {
   const queue = queues.get(win) ?? [];
   queues.set(win, queue);
-  void post(win, op);
+  queue.push(op);
+  if (queue.length === 1) void drain(win, queue);
   return op.id;
 }

+/** Posts a window's ops one at a time, in the order they were sent. */
+async function drain(win: string, queue: LayoutOp[]): Promise<void> {
+  while (queue[0]) {
+    await post(win, queue[0]);
+    queue.shift();
+  }
+}
+
 export function pendingOps(win: string): number {
   return queues.get(win)?.length ?? 0;
 }
`;

const LAYOUT_TEST = `diff --git a/gui/frontend/src/stores/layout.test.ts b/gui/frontend/src/stores/layout.test.ts
index 1d276ed..2ae608d 100644
--- a/gui/frontend/src/stores/layout.test.ts
+++ b/gui/frontend/src/stores/layout.test.ts
@@ -12,6 +12,13 @@ describe("sendOp", () => {
     expect(pendingOps("w1")).toBe(1);
   });

+  it("posts a window's ops in order", async () => {
+    sendOp("w1", open("a"));
+    sendOp("w1", open("b"));
+    await settled();
+    expect(posted()).toEqual(["a", "b"]);
+  });
+
   it("keeps windows apart", () => {
     sendOp("w1", open("a"));
     sendOp("w2", open("b"));
`;

function mail(sha: string, n: string, subject: string, body: string, stat: string, diff: string): string {
  return `From ${sha} Mon Sep 17 00:00:00 2001
From: dev <dev@example.com>
Date: Fri, 13 Nov 2026 16:20:11 -0800
Subject: [PATCH${n}] ${subject}

${body}${body ? "\n\n" : ""}---
${stat}

${diff}--
2.47.1

`;
}

/** `git format-patch -1`: a commit's subject and two files. */
export const FORMAT_PATCH = mail(
  "a4a92c61b0d4f7e2c9a1b3d5e7f9a0c2e4b6d8f0",
  "",
  "fix(gui): send a window's layout ops one at a time, in order",
  "",
  " gui/frontend/src/stores/layout.ts      | 11 ++++++++++-\n gui/frontend/src/stores/layout.test.ts |  7 +++++++\n 2 files changed, 17 insertions(+), 1 deletion(-)",
  LAYOUT + LAYOUT_TEST,
);

const RENAME_BINARY = `diff --git a/docs/notes/greeting.md b/docs/notes/welcome-greeting.md
similarity index 86%
rename from docs/notes/greeting.md
rename to docs/notes/welcome-greeting.md
index 9b3fdc6..c849c77 100644
--- a/docs/notes/greeting.md
+++ b/docs/notes/welcome-greeting.md
@@ -1,3 +1,3 @@
 # Greeting
-Hello.
+Hello there.
 Bye.
diff --git a/gui/frontend/public/logo.png b/gui/frontend/public/logo.png
index 5e1c309..1d2c3b4 100644
Binary files a/gui/frontend/public/logo.png and b/gui/frontend/public/logo.png differ
diff --git a/scripts/release.sh b/scripts/release.sh
old mode 100644
new mode 100755
diff --git a/docs/old-plan.md b/docs/old-plan.md
deleted file mode 100644
index 7a8b9c0..0000000
--- a/docs/old-plan.md
+++ /dev/null
@@ -1,3 +0,0 @@
-# Plan
-
-Ship it.
`;

/** `git format-patch --stdout -2`: two commits in one file. */
export const SERIES_PATCH =
  mail(
    "1d276ed05b3c5e7a9f1d3b5c7e9a1b3d5f7a9c1e",
    " 1/2",
    "docs: rename the greeting note and refresh the logo",
    "The note is about the welcome page now.",
    " docs/notes/{greeting.md => welcome-greeting.md} | 2 +-\n 1 file changed",
    RENAME_BINARY,
  ) + mail("a4a92c61b0d4f7e2c9a1b3d5e7f9a0c2e4b6d8f0", " 2/2", "fix(gui): send a window's layout ops one at a time, in order", "", " 2 files changed", LAYOUT + LAYOUT_TEST);

/** `git diff -M`: a rename, a binary, a mode change and a deletion; no header. */
export const RENAME_BINARY_DIFF = RENAME_BINARY;

/** `diff -u old new`: no git header, timestamps after the names. */
export const PLAIN_DIFF = `--- config.old.toml\t2026-11-13 10:00:00.000000000 +0100
+++ config.toml\t2026-11-13 10:05:12.000000000 +0100
@@ -1,10 +1,11 @@
 [daemon]
-port = 9240
+port = 9245
 log = "text"

 [gui]
 theme = "dark"
-zoom = 1.0
+zoom = 1.1
+font = "Geist"

 [threads]
 model = "sonnet"
`;

/** A diff whose last hunk is cut short, then something that is not a diff. */
export const BROKEN_DIFF = `${LAYOUT}diff --git a/gui/frontend/src/stores/layout.test.ts b/gui/frontend/src/stores/layout.test.ts
index 1d276ed..2ae608d 100644
--- a/gui/frontend/src/stores/layout.test.ts
+++ b/gui/frontend/src/stores/layout.test.ts
@@ -12,6 +12,13 @@ describe("sendOp", () => {
     expect(pendingOps("w1")).toBe(1);
   });

+  it("posts a window's ops in order", async () => {
+    sendOp("w1", open("a"));
`;

/** A `.diff` that holds no diff. */
export const NOT_A_DIFF = `Notes on the diff tool

We should compare the two branches before the release and write down
what changed. Nothing here is a diff yet.
`;

/** A patch of about `bytes` (default 1 MiB): many files of one small hunk each, then a few long ones. */
export function bigPatch(bytes = 1024 * 1024): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const path = `src/generated/module-${String(i).padStart(4, "0")}.ts`;
    const long = i % 50 === 49;
    const n = long ? 400 : 12;
    const body: string[] = [];
    for (let l = 0; l < n; l++) {
      if (l % 6 === 2) body.push(`-export const value${String(l)} = ${String(l)};`, `+export const value${String(l)} = ${String(l * 2)}; // doubled`);
      else body.push(` export const value${String(l)} = ${String(l)};`);
    }
    const olds = body.filter((b) => !b.startsWith("+")).length;
    const news = body.filter((b) => !b.startsWith("-")).length;
    const part = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${String(olds)} +1,${String(news)} @@\n${body.join("\n")}\n`;
    parts.push(part);
    size += part.length;
  }
  return parts.join("");
}

/** The fixtures by path under the checkout, with the daemon's mime for patches. */
export function patchFixtures(): [string, string][] {
  return [
    ["docs/patches/0001-fix-layout-ops.patch", FORMAT_PATCH],
    ["docs/patches/series.patch", SERIES_PATCH],
    ["docs/patches/rename-binary.diff", RENAME_BINARY_DIFF],
    ["docs/patches/config.diff", PLAIN_DIFF],
    ["docs/patches/broken.diff", BROKEN_DIFF],
    ["docs/patches/notes.diff", NOT_A_DIFF],
    ["docs/patches/empty.patch", ""],
    ["docs/patches/big.patch", bigPatch()],
  ];
}
