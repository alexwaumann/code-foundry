// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { getDraft, updateDraft } from "@/stores/compose";
import { useThreadStore } from "@/stores/thread";
import { threadDraftKey } from "@/stores/threadActions";
import { useSettingsStore } from "@/stores/settings";
import { seedComposer, settle } from "@/test/composerWorld";
import { invocationsOf } from "@/test/daemonFakes";
import { addThreads, CF, thread } from "@/test/projectsWorld";
import { ThreadComposer } from "./ThreadComposer";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));
vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

/**
 * The mock's scripted thread "Fix stale PR badge" in code-foundry (mock/thread.ts), under a
 * new id per test: stores/failedNotice keeps a send's hold per thread for the module's life.
 */
let ID = "s-r1";
let seq = 0;
const ATTACHMENT = "/mock/attachments/pr-badge-stale.png";
const CRASHED = {
  text: `The PR badge in the sidebar stays green after a force-push, see [Image: pr-badge-stale.png; ref=${ATTACHMENT}] Look at @cf-file://repo-cf/internal/store/pr/poller.go and tell me why the fingerprint misses it with /tdd .`,
  composerText:
    "The PR badge in the sidebar stays green after a force-push, see ![pr-badge-stale.png](cf-attachment://0) Look at [poller.go](cf-file://repo-cf/internal/store/pr/poller.go) and tell me why the fingerprint misses it with [/tdd](cf-skill://~/tdd).",
};

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: null, streaming: false };
const user = (id: string, ordinal: number, text: string, o: Partial<{ composerText: string; attachments: string[] }> = {}): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "user",
  text,
  attachments: o.attachments ?? [],
  composerText: o.composerText ?? "",
});
const turnEnd = (id: string, ordinal: number, o: { isError: boolean; subtype: string; terminalReason?: string }): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "turnEnd",
  subtype: o.subtype,
  isError: o.isError,
  interrupted: false,
  stopReason: "",
  terminalReason: o.terminalReason ?? "",
  durationMs: 0,
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

/** s-r1 with its log: the thread's state and items as the daemon streams them. */
function seedThread(o: Partial<ThreadView>, items: ThreadItemView[]): void {
  addThreads(thread(ID, { name: "Fix stale PR badge", worktreePath: CF, checkoutPaths: [{ projectId: "repo-cf", path: CF }], ...o }));
  act(() => {
    useThreadStore.setState({ logs: { [ID]: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  });
}

const note = () => screen.queryByTestId("thread-failed-note");
const reason = () => screen.getByTestId("thread-failed-reason").textContent;
const sends = () => invocationsOf("thread.send").map((i) => i.args);

beforeEach(() => {
  ID = `s-r${String(++seq)}`;
  seedComposer();
  useSettingsStore.setState((s) => ({ snapshot: s.snapshot ? { ...s.snapshot, values: { ...s.snapshot.values, "dictation.enabled": "false" } } : s.snapshot }));
});

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {} });
});

describe("the failed-prompt notice (composer-failed-notice.spec.ts)", () => {
  it("Claude did not start: the reason with its icon and two buttons; Send again sends the same message, the notice goes, the draft is untouched", async () => {
    seedThread({ state: "disconnected", status: "idle" }, [
      user("u1", 1, CRASHED.text, { composerText: CRASHED.composerText, attachments: [ATTACHMENT] }),
      { ...base, id: "e1", ordinal: 2, kind: "error", text: "Claude did not start: exit code 1: error: unknown option '--bogus'" },
    ]);
    render(<ThreadComposer threadId={ID} pending={[]} busy={false} />);
    await settle();
    expect(reason()).toBe("Claude did not start, so your message was not sent.");
    const n = note();
    if (!n) throw new Error("no notice");
    expect(n.querySelector("svg.lucide-circle-alert")).not.toBeNull();
    // No close button: just the two, in order.
    expect(within(n).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edit", "Send again"]);

    act(() => {
      fireEvent.click(screen.getByTestId("thread-failed-resend"));
    });
    await settle();
    expect(note()).toBeNull();
    expect(sends()).toEqual([{ id: ID, text: CRASHED.text, attachments: ATTACHMENT, "composer-text": CRASHED.composerText }]);
    expect(getDraft(threadDraftKey(ID)).text).toBe("");
  });

  it("a turn that ends in error before any text: the request failed; any message sent clears it", async () => {
    seedThread({ state: "connected", status: "idle" }, [user("u1", 1, "Run the tests"), turnEnd("t1", 2, { isError: true, subtype: "error_during_execution" })]);
    render(<ThreadComposer threadId={ID} pending={[]} busy={false} />);
    await settle();
    expect(reason()).toBe("The request failed (error during execution), so your message was not sent.");
    act(() => {
      updateDraft(threadDraftKey(ID), { text: "Never mind, check the lint" });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("thread-send"));
    });
    await settle(20);
    expect(note()).toBeNull();
    expect(sends().map((s) => s.text)).toEqual(["Never mind, check the lint"]);
  });

  it("an API error in place of a reply: the request failed with its reason; Send again sends the same message", async () => {
    seedThread({ state: "connected", status: "idle" }, [
      user("u1", 1, "Run the tests"),
      { ...base, id: "x1", ordinal: 2, kind: "text", text: "Invalid API key · Fix external API key", apiError: true },
      turnEnd("t1", 3, { isError: true, subtype: "success", terminalReason: "api_error" }),
    ]);
    render(<ThreadComposer threadId={ID} pending={[]} busy={false} />);
    await settle();
    expect(reason()).toBe("The request failed (invalid API key), so your message was not sent.");
    act(() => {
      fireEvent.click(screen.getByTestId("thread-failed-resend"));
    });
    await settle();
    expect(note()).toBeNull();
    expect(sends().map((s) => s.text)).toEqual(["Run the tests"]);
  });
});

describe("thread tags in the thread composer (composer-threads.spec.ts)", () => {
  it("the send projects a thread tag for the daemon and keeps the tag as the composer text", async () => {
    seedThread({ state: "connected", status: "idle" }, [user("u1", 1, "hi")]);
    render(<ThreadComposer threadId={ID} pending={[]} busy={false} />);
    await settle();
    act(() => {
      updateDraft(threadDraftKey(ID), { text: "[Fix resize race](cf-thread://s-3) has the same race" });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("thread-send"));
    });
    await settle(20);
    expect(sends()).toEqual([{ id: ID, text: '[Thread "Fix resize race" (id s-3)] has the same race', "composer-text": "[Fix resize race](cf-thread://s-3) has the same race" }]);
  });
});
