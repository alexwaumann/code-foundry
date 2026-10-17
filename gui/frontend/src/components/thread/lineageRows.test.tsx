import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

/** The daemon's "Created by" note in the timeline (docs/notes/agents-3-lineage-gui.md). */

const NOW = Date.now();
const base = { parentToolUseId: "", updatedAtMs: NOW, streaming: false };
const note = (id: string, text: string): ThreadItemView => ({ ...base, id, ordinal: 1, kind: "note", text, createdAtMs: NOW - 18 * 60_000 });
const user: ThreadItemView = { ...base, id: "u", ordinal: 2, kind: "user", text: "go", attachments: [], composerText: "", createdAtMs: NOW };

const t = (id: string, o: Partial<ThreadView> = {}) => ({ id, name: `name ${id}`, createdBy: "", createdByName: "", ...o }) as ThreadView;

function setThreads(list: ThreadView[]): void {
  useThreadsStore.setState({ byId: Object.fromEntries(list.map((x) => [x.id, x])), order: list.map((x) => x.id) });
}

function show(items: ThreadItemView[]) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
  return render(
    <div className="cf-thread">
      <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
        {rows.map((r) => (
          <TimelineRowView key={r.key} row={r} />
        ))}
      </ThreadContext.Provider>
    </div>,
  ).container;
}

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  setThreads([t("p", { name: "Fix login redirect" }), t("s", { name: "Add retry", createdBy: "p", createdByName: "Fix login redirect" })]);
  useUiStore.setState({ selection: { kind: "thread", id: "s" } });
});

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

describe("Created by note", () => {
  it("one muted line: ↳, Created by, the creator as a link, the brief, the age; not the divider", () => {
    const el = show([note("note-created-by", "Created by Fix login redirect · brief: Add retry, keep the PR small"), user]);
    const row = q(el, "thread-created-by-note") as HTMLElement;
    expect(row.className).toBe("lnote");
    expect(row.querySelector("svg.lucide-corner-down-right")).not.toBeNull();
    expect(row.textContent).toBe("Created byFix login redirect·brief: Add retry, keep the PR small18 min ago");
    expect(q(el, "thread-note")).toBeNull();
    // Not expandable: no chevron, the line is not a button.
    expect(q(row, "thread-created-by-note-line")?.getAttribute("role")).toBeNull();
    const link = q(row, "thread-created-by-note-link") as HTMLElement;
    expect(link.tagName).toBe("BUTTON");
    expect(link.getAttribute("data-thread")).toBe("p");
    fireEvent.click(link);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "p" });
  });

  it("no brief: just the creator", () => {
    const el = show([note("note-created-by", "Created by Fix login redirect")]);
    expect(q(el, "thread-created-by-note-brief")).toBeNull();
    expect(q(el, "thread-created-by-note")?.textContent).toBe("Created byFix login redirect18 min ago");
  });

  it("the recorded name says where a name with the separator ends", () => {
    setThreads([t("p", { name: "A · brief: B" }), t("s", { createdBy: "p", createdByName: "A · brief: B" })]);
    const el = show([note("note-created-by", "Created by A · brief: B · brief: c")]);
    expect(q(el, "thread-created-by-note-link")?.textContent).toBe("A · brief: B");
    expect(q(el, "thread-created-by-note-brief")?.textContent).toBe("brief: c");
  });

  it("a removed creator: the name as muted text, no link", () => {
    setThreads([t("s", { createdBy: "p", createdByName: "Fix login redirect" })]);
    const el = show([note("note-created-by", "Created by Fix login redirect · brief: x")]);
    expect(q(el, "thread-created-by-note-link")).toBeNull();
    const name = q(el, "thread-created-by-note-name") as HTMLElement;
    expect(name.className).toBe("nm gone");
    expect(name.textContent).toBe("Fix login redirect");
  });

  it("a fork's copied note: resolved by name, plain text when ambiguous", () => {
    setThreads([t("p", { name: "Fix login redirect" }), t("s", { name: "Fork" })]);
    let el = show([note("note-created-by", "Created by Fix login redirect")]);
    expect(q(el, "thread-created-by-note-link")?.getAttribute("data-thread")).toBe("p");
    cleanup();
    setThreads([t("p", { name: "Fix login redirect" }), t("p2", { name: "Fix login redirect" }), t("s", { name: "Fork" })]);
    el = show([note("note-created-by", "Created by Fix login redirect")]);
    expect(q(el, "thread-created-by-note-link")).toBeNull();
    expect(q(el, "thread-created-by-note-name")?.textContent).toBe("Fix login redirect");
  });

  it("a fork's note stays the centered divider", () => {
    const el = show([note("note-fork-p", "Forked from Fix login redirect")]);
    expect(q(el, "thread-created-by-note")).toBeNull();
    expect(q(el, "thread-note")?.textContent).toBe("Forked from Fix login redirect");
    expect(q(el, "thread-note")?.getAttribute("role")).toBe("separator");
  });
});
