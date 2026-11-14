import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApplyView, LayoutOpView } from "@/api/layout";

/**
 * The order one action's layout requests reach the daemon in (docs/notes/shell-25i-open-order.md).
 * The wire between the window and the daemon is the test's: a request sent waits on it until the
 * test delivers it to the fake daemon (the mock daemon's layout, test/fakeLayout.ts), and the test
 * delivers the newest one first, as two requests in flight may arrive. Before the fix the tag's
 * opens were all in flight at once, so the shown pull request's open could land before the
 * other's, and the other's tab ended active.
 */
const net = vi.hoisted(() => ({
  wire: [] as { op: LayoutOpView; deliver: () => void }[],
  /** The most requests on the wire at once. */
  most: 0,
}));

vi.mock("@/api/layout", async (orig) => {
  const api = (await import("@/test/fakeLayout")).fakeLayoutApi(await orig());
  return {
    ...api,
    applyLayoutOp: (op: LayoutOpView) =>
      new Promise<LayoutApplyView>((resolve, reject) => {
        net.wire.push({ op, deliver: () => void api.applyLayoutOp(op).then(resolve, reject) });
        net.most = Math.max(net.most, net.wire.length);
      }),
  };
});

const { appliedOps, layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const host = await import("./host");
const { openPullRequestInPanel } = await import("@/stores/prPanel");
const { useUiStore } = await import("@/stores/ui");
const { applyLayout } = await import("@/stores/layout");

/** Delivers what is on the wire, the newest request first, until nothing more is sent. */
async function deliverNewestFirst(): Promise<void> {
  for (;;) {
    // Lets a request sent after an answer reach the wire.
    await new Promise((r) => setTimeout(r, 0));
    const next = net.wire.pop();
    if (!next) break;
    next.deliver();
  }
  await layoutSettled();
}

/** The pull request numbers of the thread's PR tabs, and the one its pane shows. */
function prTabs(): { numbers: string[]; active: string | undefined } {
  const place = host.tabPlace(host.threadTarget("s-1"));
  const g = place.groups.find((x) => x.tabs.some((t) => t.kind === "pullrequest"));
  return { numbers: (g?.tabs ?? []).map((t) => t.params.number ?? ""), active: g?.active?.params.number };
}

beforeEach(async () => {
  net.wire.length = 0;
  net.most = 0;
  await resetFakeLayout(threadSeed("s-1"));
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

describe("one action's layout requests", () => {
  // What the sidebar tag's click does (LinkedPrsBadge openLinked): the others, then the shown one.
  it("open in the order made, one on the wire at a time, so the last one opened is the active tab", async () => {
    openPullRequestInPanel({ slug: "o/r", number: 147 }, "thread:s-1", { focus: false });
    openPullRequestInPanel({ slug: "o/ghostty", number: 12 }, "thread:s-1", { focus: false });
    await deliverNewestFirst();
    expect(prTabs()).toEqual({ numbers: ["147", "12"], active: "12" });
    expect(appliedOps.map((o) => (o.op === "open_surface" ? o.tab.params?.number : o.op))).toEqual(["147", "12"]);
    expect(net.most).toBe(1);
  });

  it("a refused request does not hold back the ones after it", async () => {
    // A tab the daemon no longer has: close_tab is refused (NotFound).
    const closed = applyLayout({ op: "close_tab", tab: "t-gone" }).then(
      () => "closed",
      () => "refused",
    );
    openPullRequestInPanel({ slug: "o/r", number: 5 }, "thread:s-1", { focus: false });
    await deliverNewestFirst();
    expect(await closed).toBe("refused");
    expect(prTabs()).toEqual({ numbers: ["5"], active: "5" });
  });

  // A no-focus open never changes what the focused pane shows: it opens behind there, and on top in
  // a pane without the focus. So the focus moving off the PR pane must land before the open does.
  it("the focus moved to the thread's pane, then a pull request opened: it opens on top of its pane", async () => {
    openPullRequestInPanel({ slug: "o/r", number: 1 }, "thread:s-1", { focus: false });
    openPullRequestInPanel({ slug: "o/r", number: 2 }, "thread:s-1", { focus: false });
    await deliverNewestFirst();
    host.activateTab(host.threadTarget("s-1"), host.pullRequestTabId("o/r", "1"));
    await deliverNewestFirst();
    expect(prTabs().active).toBe("1");
    // The action: the thread's own tab focused, then #3 opened.
    host.activateTab("current", "t-s-1");
    openPullRequestInPanel({ slug: "o/r", number: 3 }, "thread:s-1", { focus: false });
    await deliverNewestFirst();
    expect(prTabs()).toEqual({ numbers: ["1", "2", "3"], active: "3" });
    expect(net.most).toBe(1);
  });
});
