import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

function show(items: ThreadItemView[]) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
  return render(
    <ThreadContext.Provider value={{ sessionId: "s", cwd: "/w" }}>
      {rows.map((r) => (
        <TimelineRowView key={r.key} row={r} />
      ))}
    </ThreadContext.Provider>,
  ).container;
}

function editWaiting(name: string, input: object): ThreadItemView[] {
  return [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
    { ...base, id: "tu", ordinal: 2, kind: "tool", toolUseId: "tu", name, inputJson: JSON.stringify(input), status: "running", output: "", isError: false, resultJson: "" },
    {
      ...base,
      id: "perm-r",
      ordinal: 3,
      kind: "permission",
      request: {
        requestId: "r",
        toolName: name,
        displayName: name,
        title: "",
        description: "",
        toolUseId: "tu",
        agentId: "",
        blockedPath: "",
        decisionReason: "",
        inputJson: JSON.stringify(input),
        suggestionsJson: "",
        state: "pending",
        decision: "",
        message: "",
        answers: {},
      },
    },
  ];
}

describe("a tool waiting for permission", () => {
  it("an Edit shows its diff, so the user sees what they allow", () => {
    const c = show(editWaiting("Edit", { file_path: "/w/a.go", old_string: "x := 1", new_string: "x := 2" }));
    expect(c.querySelector('[data-waiting="true"]')?.textContent).toContain("waiting for you");
    expect(c.querySelector('[data-testid="thread-diff"]')?.textContent).toContain("x := 2");
  });

  it("a Bash call does not expand (the docked prompt shows the command)", () => {
    const c = show(editWaiting("Bash", { command: "git push" }));
    expect(c.querySelector('[data-waiting="true"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="thread-bash"]')).toBeNull();
  });
});
