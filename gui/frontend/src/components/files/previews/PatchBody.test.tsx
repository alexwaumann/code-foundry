import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeViewItem } from "@pierre/diffs";
import { blankFile, type FileReadView } from "@/api/files";
import { useCodeViewStore } from "@/stores/codeView";
import { PatchBody } from "./PatchBody";
import { PatchControls } from "./PatchControls";
import patch from "./kinds/patch";

// The library's CodeView needs a real browser (shadow roots, layout): e2e/file-previews-patch.spec.ts
// covers what it draws. The stub draws what PatchBody hands it: the header above the items and each
// item's own header, with the item's fold state.
interface StubProps {
  items: readonly CodeViewItem<undefined>[];
  renderCustomHeader: (item: CodeViewItem<undefined>) => ReactNode;
  renderCodeViewHeader?: () => ReactNode;
}
vi.mock("@pierre/diffs/react", () => ({
  CodeView: ({ items, renderCustomHeader, renderCodeViewHeader }: StubProps) => (
    <div data-testid="code-view-stub">
      {renderCodeViewHeader?.()}
      {items.map((it) => (
        <div key={it.id} data-item={it.id} data-collapsed={it.collapsed ?? false} data-version={it.version ?? 0}>
          {renderCustomHeader(it)}
        </div>
      ))}
    </div>
  ),
}));
const statFile = vi.hoisted(() => vi.fn());
vi.mock("@/api/files", async (orig) => ({ ...(await orig<typeof import("@/api/files")>()), statFile }));
const openFileInPanel = vi.hoisted(() => vi.fn());
vi.mock("@/stores/filePanel", () => ({ openFileInPanel }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify }));

const PATH = "/w/0001-fix.patch";
const A = `diff --git a/src/stores/layout.ts b/src/stores/layout.ts
index 3f813da..a4a92c6 100644
--- a/src/stores/layout.ts
+++ b/src/stores/layout.ts
@@ -1,3 +1,4 @@
 one
-two
+deux
+trois
 four
`;
const B = `diff --git a/src/stores/layout.test.ts b/src/stores/layout.test.ts
index 1d276ed..2ae608d 100644
--- a/src/stores/layout.test.ts
+++ b/src/stores/layout.test.ts
@@ -1,2 +1,3 @@
 a
+b
 c
`;
const mail = (sha: string, subject: string, diff: string) =>
  `From ${sha} Mon Sep 17 00:00:00 2001\nFrom: dev <dev@example.com>\nDate: Fri, 13 Nov 2026 12:00:00 +0000\nSubject: [PATCH] ${subject}\n\n---\n stat\n\n${diff}-- \n2.47.1\n\n`;
const ONE = mail("a4a92c61b0d4f7e2c9a1b3d5e7f9a0c2e4b6d8f0", "fix(gui): send ops in order", A + B);
const RENAME_BINARY = `diff --git a/docs/greeting.md b/docs/welcome.md
similarity index 86%
rename from docs/greeting.md
rename to docs/welcome.md
--- a/docs/greeting.md
+++ b/docs/welcome.md
@@ -1 +1 @@
-Hello.
+Hello there.
diff --git a/public/logo.png b/public/logo.png
index 5e1c309..1d2c3b4 100644
Binary files a/public/logo.png and b/public/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

const fileOf = (text: string, over: Partial<FileReadView> = {}): FileReadView => ({ ...blankFile(PATH), text, mime: "text/x-diff", size: text.length, ...over });

function show(text: string, opts: { project?: string; onMode?: (m: string) => void } = {}) {
  return render(
    <PatchBody
      file={fileOf(text)}
      path={PATH}
      mode="diff"
      name="0001-fix.patch"
      place={{ project: opts.project ?? "repo", dir: "/w", file: PATH }}
      page={undefined}
      reloads={0}
      findKey={undefined}
      onMeta={vi.fn()}
      onMode={opts.onMode ?? vi.fn()}
    />,
  );
}

const rows = () => screen.getAllByTestId("file-patch-file");
const rowOf = (path: string) => rows().find((r) => r.dataset.path === path) as HTMLElement;
const itemOf = (path: string) => rowOf(path).parentElement as HTMLElement;

beforeEach(() => {
  useCodeViewStore.setState({ diffStyle: "unified", wrap: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("PatchBody", () => {
  it("a format-patch: the subject and byline on top, then a row per file with + and −", () => {
    show(ONE);
    const head = screen.getByTestId("file-patch-commit-head");
    expect(head.textContent).toBe("fix(gui): send ops in orderdev · Nov 13, 2026 · a4a92c6");
    expect(rows().map((r) => r.dataset.path)).toEqual(["src/stores/layout.ts", "src/stores/layout.test.ts"]);
    expect(rowOf("src/stores/layout.ts").textContent).toContain("+2−1");
    expect(rowOf("src/stores/layout.test.ts").textContent).toContain("+1");
    expect(rowOf("src/stores/layout.test.ts").textContent).not.toContain("−");
    expect(screen.queryByTestId("file-patch-status")).toBeNull();
    expect(screen.queryByTestId("file-patch-problems")).toBeNull();
    expect(screen.queryByTestId("file-patch-commit")).toBeNull();
  });

  it("a plain diff: no header, just the files", () => {
    show(A);
    expect(screen.queryByTestId("file-patch-commit-head")).toBeNull();
    expect(rows().map((r) => r.dataset.path)).toEqual(["src/stores/layout.ts"]);
  });

  it("a mailbox: a row per commit, numbered, before its files", () => {
    show(ONE + mail("1d276ed05b3c5e7a9f1d3b5c7e9a1b3d5f7a9c1e", "test: cover it", B));
    expect(screen.queryByTestId("file-patch-commit-head")).toBeNull();
    const order = [...screen.getByTestId("code-view-stub").querySelectorAll("[data-testid=file-patch-commit], [data-testid=file-patch-file]")].map((e) =>
      e.getAttribute("data-testid") === "file-patch-commit" ? e.textContent : `  ${e.getAttribute("data-path") ?? ""}`,
    );
    expect(order).toEqual([
      "1/2fix(gui): send ops in orderdev · Nov 13, 2026 · a4a92c6",
      "  src/stores/layout.ts",
      "  src/stores/layout.test.ts",
      "2/2test: cover itdev · Nov 13, 2026 · 1d276ed",
      "  src/stores/layout.test.ts",
    ]);
  });

  it("a rename shows old → new; a binary and a mode change show a note instead of a diff and do not fold", () => {
    show(RENAME_BINARY);
    const rename = rowOf("docs/welcome.md");
    expect(within(rename).getByTestId("file-patch-path").textContent.replace(/\u200e/g, "")).toBe("docs/greeting.md→docs/welcome.md");
    expect(within(rename).getByTestId("file-patch-status").textContent).toBe("renamed");
    expect(within(rowOf("public/logo.png")).getByTestId("file-patch-note").textContent).toBe("Binary file");
    expect(within(rowOf("run.sh")).getByTestId("file-patch-note").textContent).toBe("Mode 100644 → 100755");
    expect(itemOf("public/logo.png").dataset.collapsed).toBe("true");
    expect(within(rowOf("public/logo.png")).queryByTestId("file-patch-fold")).toBeNull();
    fireEvent.click(rowOf("public/logo.png"));
    expect(itemOf("public/logo.png").dataset.collapsed).toBe("true");
  });

  it("clicking a file's row folds it and opens it again", () => {
    show(ONE);
    const item = () => itemOf("src/stores/layout.ts");
    expect([item().dataset.collapsed, item().dataset.version]).toEqual(["false", "0"]);
    fireEvent.click(rowOf("src/stores/layout.ts"));
    expect([item().dataset.collapsed, item().dataset.version]).toEqual(["true", "1"]);
    expect(within(rowOf("src/stores/layout.ts")).getByTestId("file-patch-fold").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(rowOf("src/stores/layout.ts")).getByTestId("file-patch-fold"));
    expect([item().dataset.collapsed, item().dataset.version]).toEqual(["false", "2"]);
    expect(itemOf("src/stores/layout.test.ts").dataset.collapsed).toBe("false");
  });

  it("a hunk cut short: a notice on top, a mark on the file, and what parsed", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    show(A + B.split("\n").slice(0, -2).join("\n") + "\n");
    expect(screen.getByTestId("file-patch-problems").textContent).toContain("1 file did not parse whole");
    expect(within(rowOf("src/stores/layout.test.ts")).getByTestId("file-patch-problem")).toBeTruthy();
    expect(within(rowOf("src/stores/layout.ts")).queryByTestId("file-patch-problem")).toBeNull();
  });

  it("not a diff: says so, with Show source", () => {
    const onMode = vi.fn();
    show("Just notes.\nNothing to apply.\n", { onMode });
    expect(screen.getByTestId("file-patch-none").textContent).toContain("No diff in this file");
    fireEvent.click(screen.getByTestId("file-patch-show-source"));
    expect(onMode).toHaveBeenCalledWith("source");
  });

  it("an empty file says so", () => {
    show("");
    expect(screen.getByTestId("file-patch-empty").textContent).toContain("Empty patch");
  });

  it("a cover letter alone: its header and no files", () => {
    show("From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: A <a@x>\nSubject: [PATCH 0/2] the series\n\nIt does things.\n");
    expect(screen.getByTestId("file-patch-commit-head").textContent).toContain("the series");
    expect(screen.getByTestId("file-patch").textContent).toContain("No file changes in this patch.");
  });

  it("Open file opens it in a File tab when the checkout has it, and says so when not", async () => {
    statFile.mockResolvedValueOnce("stamp").mockRejectedValueOnce(new Error("not found"));
    show(ONE);
    fireEvent.click(within(rowOf("src/stores/layout.ts")).getByTestId("file-patch-open"));
    await waitFor(() => {
      expect(openFileInPanel).toHaveBeenCalledWith("current", { project: "repo", base: "/w", path: "src/stores/layout.ts" });
    });
    expect(statFile).toHaveBeenCalledWith("/w", "src/stores/layout.ts");
    // Open is not a fold.
    expect(itemOf("src/stores/layout.ts").dataset.collapsed).toBe("false");
    fireEvent.click(within(rowOf("src/stores/layout.test.ts")).getByTestId("file-patch-open"));
    await waitFor(() => {
      expect(notify).toHaveBeenCalledWith({ level: "info", title: "Not in this checkout", description: "src/stores/layout.test.ts" });
    });
    expect(openFileInPanel).toHaveBeenCalledTimes(1);
  });

  it("no Open file outside a project, or for a deleted file", () => {
    show(ONE, { project: "" });
    expect(screen.queryByTestId("file-patch-open")).toBeNull();
    cleanup();
    show("diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n");
    expect(within(rowOf("gone.ts")).getByTestId("file-patch-status").textContent).toBe("deleted");
    expect(screen.queryByTestId("file-patch-open")).toBeNull();
  });
});

describe("the patch kind", () => {
  it("meta: files and + − in the diff colours, or the size when there is no diff", () => {
    const { container } = render(<>{patch.meta({ file: fileOf(ONE), path: PATH })}</>);
    expect(container.textContent).toBe("2 files · +3 −1 · Patch");
    expect(container.querySelector(".text-cf-diff-addition")?.textContent).toBe("+3");
    expect(container.querySelector(".text-cf-diff-deletion")?.textContent).toBe("−1");
    expect(patch.meta({ file: fileOf("notes\n", { size: 6 }), path: PATH })).toBe("6 B · Patch");
  });

  it("Unified | Split is the codeView store's diff style", () => {
    render(<PatchControls />);
    const radios = within(screen.getByTestId("file-patch-style")).getAllByRole("radio");
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["Unified", "true"],
      ["Split", "false"],
    ]);
    act(() => {
      fireEvent.click(screen.getByTestId("file-patch-style-split"));
    });
    expect(useCodeViewStore.getState().diffStyle).toBe("split");
  });
});
