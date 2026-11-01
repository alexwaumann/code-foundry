import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addPageError, type PageError } from "@/lib/pageErrors";
import { getDraft, useComposeStore } from "@/stores/compose";
import { threadDraftKey } from "@/stores/threadActions";
import { useUiStore } from "@/stores/ui";
import { invocationsOf, resetDaemon } from "@/test/daemonFakes";
import { PageErrors } from "./PageErrors";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

/**
 * A page's errors on its strip (docs/notes/bridge-fix-c-gui.md): the count, the popover's
 * rows (latest first, a repeat counted), and Ask Claude filling the thread's composer
 * without sending. Which answers count is bridgeHost.test.ts's; the frame reload that
 * clears them stays in e2e/bridge.spec.ts.
 */

const PAGE = "Bridge check (~/.code-foundry/pages/bridge.html)";

/** The bridge test page's three presses: thread.list misspelt twice, then a verb that does not exist. */
function errors(): PageError[] {
  let list: PageError[] = [];
  const misspelt = { call: "thread.list", code: "invalid" as const, message: 'thread.list: unknown argument "archivd"' };
  list = addPageError(list, { ...misspelt, atMs: 1 });
  list = addPageError(list, { ...misspelt, atMs: 2 });
  list = addPageError(list, { call: "no.such.verb", code: "invalid" as const, message: "unknown command no.such.verb", atMs: 3 });
  return list;
}

beforeEach(() => {
  resetDaemon();
  useComposeStore.setState({ drafts: {} });
  act(() => {
    useUiStore.getState().select({ kind: "thread", id: "s-1" });
  });
});

afterEach(cleanup);

describe("PageErrors", () => {
  it("nothing without errors", () => {
    render(<PageErrors errors={[]} threadId="s-1" page={PAGE} />);
    expect(screen.queryByTestId("page-errors")).toBeNull();
  });

  it("counts every occurrence; the popover lists the latest first, a repeat with its count; Ask Claude fills the composer, nothing sent", async () => {
    const onAsk = vi.fn();
    render(<PageErrors errors={errors()} threadId="s-1" page={PAGE} onAsk={onAsk} />);
    const badge = screen.getByTestId("page-errors");
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-label")).toBe("3 page errors");
    fireEvent.click(badge);
    const pop = await screen.findByTestId("page-errors-popover");
    const rows = within(pop).getAllByTestId("page-error");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("no.such.verb");
    expect(rows[1]?.textContent).toContain("2×");
    // The message without the call it already names.
    expect(rows[1]?.textContent).toContain('invalid unknown argument "archivd"');
    fireEvent.click(within(pop).getByTestId("page-errors-ask"));
    expect(onAsk).toHaveBeenCalledOnce();
    const text = getDraft(threadDraftKey("s-1")).text;
    expect(text).toMatch(/^The page Bridge check \(.*bridge\.html\) got these errors from Code Foundry/);
    expect(text).toMatch(/thread\.list: invalid: .*archivd.* \(2 times\)/);
    expect(invocationsOf("thread.send")).toEqual([]);
  });

  it("no Ask Claude without a thread to ask", async () => {
    render(<PageErrors errors={errors()} threadId={null} page={PAGE} />);
    fireEvent.click(screen.getByTestId("page-errors"));
    const pop = await screen.findByTestId("page-errors-popover");
    expect(within(pop).queryByTestId("page-errors-ask")).toBeNull();
  });
});
