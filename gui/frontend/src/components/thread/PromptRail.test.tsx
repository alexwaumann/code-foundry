import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { tooltipText } from "@/test/tooltip";
import { PromptRail } from "./PromptRail";
import type { TimelineListApi } from "./Timeline";

/**
 * The prompt rail (docs/notes/thread-prompt-rail.md) over the mock's s-r1: idle has two
 * prompts, streaming one. Its place in the gutter, the tooltip's clamp and the scroll it
 * follows are e2e/thread-prompt-rail.spec.ts's; the rules are lib/promptRail.test.ts's.
 */

const ATT = "/mock/attachments/pr-badge-stale.png";
const base = { parentToolUseId: "", updatedAtMs: 1, streaming: false };
// Today at 14:12 and 14:20: the tooltip's time is a bare one for today's prompts.
const at = (h: number, m: number) => new Date(new Date().setHours(h, m, 0, 0)).getTime();

const FIRST: ThreadItemView = {
  ...base,
  id: "u1",
  ordinal: 1,
  createdAtMs: at(14, 12),
  kind: "user",
  text: `The PR badge in the sidebar stays green after a force-push, see [Image: pr-badge-stale.png; ref=${ATT}] Look at @cf-file://repo-cf/internal/store/pr/poller.go and fix it with /tdd . Keep the fingerprint check-count based in /tmp.`,
  attachments: [ATT],
  composerText:
    "The PR badge in the sidebar stays green after a force-push, see ![pr-badge-stale.png](cf-attachment://0) Look at [poller.go](cf-file://repo-cf/internal/store/pr/poller.go) and fix it with [/tdd](cf-skill://~/tdd). Keep the fingerprint check-count based in /tmp.",
};
const answer = (id: string, ordinal: number): ThreadItemView => ({ ...base, id, ordinal, createdAtMs: 1, kind: "text", text: "Done." });
/** A turn's end, so the next message starts a turn (not a steer). */
const end = (id: string, ordinal: number): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  createdAtMs: 1,
  kind: "turnEnd",
  subtype: "success",
  isError: false,
  interrupted: false,
  stopReason: "",
  terminalReason: "",
  durationMs: 1000,
  numTurns: 1,
  costUsd: 0,
  turnCostUsd: null,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errors: [],
});
const user = (id: string, ordinal: number, text: string, createdAtMs = at(14, 20)): ThreadItemView => ({ ...base, id, ordinal, createdAtMs, kind: "user", text, attachments: [], composerText: "" });

const IDLE = [FIRST, answer("a1", 2), end("e1", 3), user("u2", 4, "Looks good. Run the full suite, then push the branch."), answer("a2", 5), end("e2", 6)];

const scrollToRow = vi.fn<(index: number) => void>();

/** A scroller 800px tall at the list's end (jsdom lays nothing out). */
function list(): TimelineListApi {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { value: 800 });
  return { scroller: () => el as HTMLDivElement, rowStart: (i) => i * 100, scrollToRow };
}

function show(items: ThreadItemView[], api = list()) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
  return { rows, ui: <PromptRail threadId="s" list={api} rows={rows} bottomInset={120} /> };
}

const ticks = () => screen.queryAllByTestId("prompt-rail-tick");
const current = () => ticks().map((t) => (t.hasAttribute("data-current") ? "1" : "0")).join("");

afterEach(() => {
  cleanup();
  scrollToRow.mockClear();
  useThreadStore.setState({ logs: {} });
});

describe("the prompt rail", () => {
  it("a thread with one prompt has none", () => {
    render(show([FIRST, answer("a1", 2)]).ui);
    expect(screen.queryByRole("navigation", { name: "Prompts" })).toBeNull();
  });

  it("two prompts: a tick each, labelled with its prompt; the one at the list's end is in view", async () => {
    render(show(IDLE).ui);
    expect(screen.getByRole("navigation", { name: "Prompts" }).getAttribute("data-gap")).toBe("6");
    expect(ticks().map((t) => t.getAttribute("aria-label"))).toEqual(["Prompt 1 of 2: The PR badge in the sidebar stays green after a force-push,…", "Prompt 2 of 2: Looks good. Run the full suite, then push the branch."]);
    await vi.waitFor(() => {
      expect(current()).toBe("01");
    });
    expect(ticks()[1]?.getAttribute("aria-current")).toBe("location");
  });

  it("a tick's tooltip: its prompt with the image left out and tags as their labels, then when it was sent and n of m", () => {
    render(show(IDLE).ui);
    const first = tooltipText(ticks()[0] as HTMLElement);
    expect(first).toContain("The PR badge in the sidebar stays green after a force-push, see Look at poller.go and fix it with /tdd. Keep");
    expect(first).toMatch(/\d{1,2}:12.* · 1 of 2$/);
    expect(document.querySelector('[data-testid="prompt-rail-tip"] .line-clamp-2')).not.toBeNull();
    cleanup();
    render(show(IDLE).ui);
    const second = tooltipText(ticks()[1] as HTMLElement);
    expect(second).toContain("Looks good. Run the full suite, then push the branch.");
    expect(second).toContain(" · 2 of 2");
  });

  it("a click scrolls its prompt's row to the top, the focus left where it was", () => {
    const { rows, ui } = show(IDLE);
    render(ui);
    const down = fireEvent.mouseDown(ticks()[0] as HTMLElement);
    expect(down).toBe(false);
    fireEvent.click(ticks()[0] as HTMLElement);
    expect(scrollToRow).toHaveBeenCalledWith(rows.findIndex((r) => r.type === "user" && r.id === "u1"));
  });

  it("sent prompts add ticks; the newest is in view", async () => {
    const api = list();
    const view = render(show(IDLE, api).ui);
    const sent = ["Also check the poller's interval: the note says 30 s, but settings say 20. Which one is right?", "Use the setting. Update the note too.", "Ship it."];
    let items = IDLE;
    for (const [i, text] of sent.entries()) {
      items = [...items, user(`s${String(i)}`, 10 + 3 * i, text), answer(`r${String(i)}`, 11 + 3 * i), end(`e${String(i + 3)}`, 12 + 3 * i)];
      act(() => {
        view.rerender(show(items, api).ui);
      });
      expect(ticks()).toHaveLength(3 + i);
    }
    expect(ticks()[2]?.getAttribute("aria-label")).toMatch(/^Prompt 3 of 5: Also check the poller's interval/);
    await vi.waitFor(() => {
      expect(current()).toBe("00001");
    });
    expect(tooltipText(ticks()[2] as HTMLElement)).toContain(" · 3 of 5");
  });

  it("a wake is no prompt: no tick for it", () => {
    render(show([...IDLE, { ...user("w", 9, "woken"), wake: { title: "build", json: '{"status":"ok"}' } }]).ui);
    expect(ticks()).toHaveLength(2);
  });
});
