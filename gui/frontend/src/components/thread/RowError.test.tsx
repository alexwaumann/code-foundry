import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { RowBoundary } from "./RowError";
import { TimelineRowView } from "./rows";
import { TimelineList } from "./Timeline";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

function setItems(items: ThreadItemView[]) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
}

/** Every row of the items, each behind its boundary, expanded (so tool details render too). */
function show(items: ThreadItemView[]) {
  setItems(items);
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => false, working: false });
  useThreadStore.setState({ expanded: { s: Object.fromEntries(rows.map((r) => [r.key, true])) } });
  return render(
    <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
      {rows.map((r) => (
        <RowBoundary key={r.key} threadId="s" row={r}>
          <TimelineRowView row={r} />
        </RowBoundary>
      ))}
    </ThreadContext.Provider>,
  ).container;
}

function tool(name: string, input: unknown, resultJson = ""): ThreadItemView[] {
  return [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
    { ...base, id: "t", ordinal: 2, kind: "tool", toolUseId: "t", name, inputJson: JSON.stringify(input), status: "done", output: "", isError: false, resultJson },
  ];
}

function question(input: unknown): ThreadItemView[] {
  const inputJson = JSON.stringify(input);
  return [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
    { ...base, id: "q", ordinal: 2, kind: "tool", toolUseId: "q", name: "AskUserQuestion", inputJson, status: "running", output: "", isError: false, resultJson: "" },
    {
      ...base,
      id: "question-r",
      ordinal: 3,
      kind: "question",
      request: {
        requestId: "r",
        toolName: "AskUserQuestion",
        displayName: "AskUserQuestion",
        title: "",
        description: "",
        toolUseId: "q",
        agentId: "",
        blockedPath: "",
        decisionReason: "",
        inputJson,
        suggestionsJson: "",
        state: "pending",
        decision: "",
        message: "",
        answers: {},
      },
    },
  ];
}

describe("malformed tool payloads (fuzz report)", () => {
  it.each<[string, ThreadItemView[]]>([
    ["Edit, structuredPatch [null]", tool("Edit", { file_path: "/w/a.go", old_string: "a", new_string: "b" }, '{"structuredPatch":[null]}')],
    ["Edit, a hunk without lines", tool("Edit", { file_path: "/w/a.go" }, '{"structuredPatch":[{"oldStart":1}]}')],
    ["MultiEdit, edits [null]", tool("MultiEdit", { file_path: "/w/a.go", edits: [null] })],
    ["TodoWrite, todos [null]", tool("TodoWrite", { todos: [null] })],
    ["a question, questions [null]", question({ questions: [null] })],
    ["a question, options [null]", question({ questions: [{ question: "Q", options: [null] }] })],
    ["a tool AskUserQuestion, questions [null]", tool("AskUserQuestion", { questions: [null] })],
  ])("%s renders without an error row", (_, items) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = show(items);
    expect(c.querySelector('[data-testid="row-error"]')).toBeNull();
  });
});

function Boom({ id }: { id: string }): never {
  throw new Error(`cannot render ${id}`);
}

describe("RowBoundary", () => {
  it("shows one line with the error and the row's items behind Details, and keeps its siblings", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setItems(tool("Edit", { file_path: "/w/a.go" }));
    const c = render(
      <>
        <RowBoundary threadId="s" row={{ type: "tool", key: "t", id: "t", permissionId: "", children: [] }}>
          <Boom id="t" />
        </RowBoundary>
        <RowBoundary threadId="s" row={{ type: "user", key: "u", id: "u" }}>
          <p data-testid="sibling">fine</p>
        </RowBoundary>
      </>,
    ).container;
    const row = c.querySelector('[data-testid="row-error"]');
    expect(row?.textContent).toContain("Could not render this item.");
    expect(c.querySelector('[data-testid="sibling"]')?.textContent).toBe("fine");
    fireEvent.click(c.querySelector('[data-testid="error-details-toggle"]') as Element);
    const details = c.querySelector('[data-testid="error-details"]')?.textContent ?? "";
    expect(details).toContain("cannot render t");
    expect(details).toContain('"file_path\\":\\"/w/a.go');
  });

  it("the timeline puts each row behind its own boundary: one broken row leaves the others", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // jsdom lays nothing out: give the list's scroller a height so the virtualizer renders rows.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    setItems(tool("Edit", { file_path: "/w/a.go" }));
    const rows = [
      { type: "user" as const, key: "u", id: "u" },
      { type: "tool" as const, key: "t", id: "t" },
    ];
    const c = render(
      <TimelineList
        threadId="s"
        rows={rows}
        bottomInset={0}
        renderRow={(r) => (r.key === "t" ? <Boom id="t" /> : <p data-testid="sibling">fine</p>)}
      />,
    ).container;
    expect(c.querySelectorAll('[data-testid="row-error"]')).toHaveLength(1);
    expect(c.querySelector('[data-testid="row-error"]')?.textContent).toContain("Could not render this item.");
    expect(c.querySelector('[data-testid="sibling"]')?.textContent).toBe("fine");
  });

  it("retries when one of its items changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const items = tool("Edit", {});
    setItems(items);
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("partial");
      return <p data-testid="ok">ok</p>;
    }
    const c = render(
      <RowBoundary threadId="s" row={{ type: "tool", key: "t", id: "t" }}>
        <Flaky />
      </RowBoundary>,
    ).container;
    expect(c.querySelector('[data-testid="row-error"]')).not.toBeNull();
    broken = false;
    act(() => {
      setItems([items[0] as ThreadItemView, { ...(items[1] as ThreadItemView), updatedAtMs: 2 }]);
    });
    expect(c.querySelector('[data-testid="ok"]')).not.toBeNull();
  });
});
