import { cleanup, render, screen } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { PageAccessSchema, PageConsent, PageOwnerSource } from "@/gen/codefoundry/v1/page_pb";

/**
 * A thread's card acts for its thread and keeps the page's cf.storage for its file, as the
 * daemon's grant says (docs/notes/page-storage-per-file.md), so the card and the File tab opened
 * from it are one page with one storage (thread-pages fuzz #1, author-docs #1). The frame is
 * HtmlFrame's to test; here only what the card hands it.
 */

const CF = "/Users/dev/src/code-foundry";
const PAGE = `${CF}/docs/hello.html`;

const grantPage = vi.hoisted(() => ({ page: null as unknown }));
vi.mock("@/api/files", async (orig) => {
  const { toPageAccessView } = await import("@/api/page");
  return {
    ...(await orig<typeof import("@/api/files")>()),
    previewFile: () =>
      Promise.resolve({ url: "http://127.0.0.1:1/preview/g/docs/hello.html", scope: CF, singleFile: false, pageThread: "", page: toPageAccessView(grantPage.page as Parameters<typeof toPageAccessView>[0]) }),
  };
});
vi.mock("@/components/files/HtmlFrame", () => ({
  HtmlFrame: ({ thread, storagePath, testId }: { thread?: string | null; storagePath?: string | null; testId: string }) => <div data-testid={testId} data-thread={thread ?? ""} data-storage={storagePath ?? ""} />,
}));

const { buildRows, buildTurns, decodeTimelineKey, timelineKey } = await import("@/lib/threadTimeline");
const { structOf, useThreadStore } = await import("@/stores/thread");
const { ThreadContext } = await import("./context");
const { PaneOverlay } = await import("./InlineHtml");
const { TimelineRowView } = await import("./rows");

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const ITEMS: ThreadItemView[] = [
  { ...base, id: "u", ordinal: 1, kind: "user", text: "Show the page.", attachments: [], composerText: "" },
  { ...base, id: "h1", ordinal: 2, kind: "html", path: "docs/hello.html", title: "", baseDir: CF },
];

function mount() {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, "s-r1": { seq: 2, byId: Object.fromEntries(ITEMS.map((it) => [it.id, it])), order: ITEMS.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } }));
  const rows = buildRows(buildTurns(ITEMS.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: true });
  return render(
    <ThreadContext.Provider value={{ threadId: "s-r1", cwd: CF }}>
      <PaneOverlay scope="s-r1" threadId="s-r1">
        <div data-testid="thread-timeline">
          {rows.map((r) => (
            <TimelineRowView key={r.key} row={r} />
          ))}
        </div>
      </PaneOverlay>
    </ThreadContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {}, pageModals: {} });
});

const owned = (over: object = {}) =>
  create(PageAccessSchema, {
    path: PAGE,
    ownerThread: "s-other",
    ownerSource: PageOwnerSource.WRITTEN,
    owners: [
      { threadId: "s-other", source: PageOwnerSource.WRITTEN },
      { threadId: "s-r1", source: PageOwnerSource.SHOWN },
    ],
    consent: PageConsent.OWNED,
    answer: PageConsent.NOT_ASKED,
    storagePerFile: true,
    ...over,
  });

describe("an inline page's card: whom it acts for and its storage", () => {
  it.each([
    ["another thread owns it first: the card still acts for its own thread, with the file's storage", owned(), PAGE],
    ["an older daemon: its thread's own storage", owned({ storagePerFile: false }), ""],
    ["a file that is no page (an old card of a file outside home): its thread's own storage", create(PageAccessSchema, { consent: PageConsent.UNAVAILABLE, answer: PageConsent.UNAVAILABLE, storagePerFile: true }), ""],
    ["a daemon older than page ownership", undefined, ""],
  ])("%s", async (_name, page, storage) => {
    grantPage.page = page;
    mount();
    const frame = await screen.findByTestId("thread-html-frame");
    expect(frame.dataset.thread).toBe("s-r1");
    expect(frame.dataset.storage).toBe(storage);
  });
});
