import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { PlaceGroup } from "./PlaceGroup";

const thread = (o: Partial<ThreadView>) =>
  ({
    id: "s-3",
    name: "Deploy",
    projectId: "web",
    worktreePath: "/src/web",
    workspaceId: "",
    projectIds: ["web"],
    checkoutPaths: [],
    branch: "",
    createdWorktree: false,
    flags: [],
    ...o,
  }) as ThreadView;

const flag = (pluginName: string, level: string, reason: string): ThreadView["flags"][number] => ({ plugin: pluginName.toLowerCase(), pluginName, level, reason, setAtMs: 1, untilSeen: false }) as ThreadView["flags"][number];

function setThread(o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState({ byId: { "s-3": thread(o) }, order: ["s-3"] });
  });
}

/** The project row's hover card, opened as keyboard navigation would. */
function notes(): HTMLElement {
  const row = screen.getByTestId("ti-project");
  fireEvent.keyDown(document, { key: "Tab" });
  act(() => {
    row.focus();
  });
  return within(screen.getByRole("tooltip")).getByTestId("ti-project-notes");
}

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: { id: "web", name: "web", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/web", branch: "main", head: "a", isMain: true }] } } as never, order: ["web"] });
  setThread({});
});

afterEach(cleanup);

describe("PlaceGroup: the project row's notes", () => {
  it("no mark without flags or a changed environment", () => {
    render(<PlaceGroup threadId="s-3" />);
    expect(within(screen.getByTestId("ti-project")).queryByTestId("ti-project-mark")).toBeNull();
  });

  it("a plugin's flag marks the row in its colour; the hover card says who and why", () => {
    render(<PlaceGroup threadId="s-3" />);
    setThread({ flags: [flag("Hello", "error", "build failed")] });
    const mark = within(screen.getByTestId("ti-project")).getByTestId("ti-project-mark");
    expect(mark.getAttribute("class")).toContain("text-cf-error-text");
    const f = within(notes()).getByTestId("ti-project-flag");
    expect(f.textContent).toBe("Hello: build failed");
    expect(f.dataset.level).toBe("error");
    expect(f.className).toContain("text-cf-error-text");
  });

  it("a changed plugin environment marks the row; the hover card says what changed and what Restart Claude does", () => {
    render(<PlaceGroup threadId="s-3" />);
    setThread({ pluginEnvStale: true, pluginEnvChange: "Hello removed CF_HELLO" });
    expect(within(screen.getByTestId("ti-project")).getByTestId("ti-project-mark")).toBeTruthy();
    expect(within(notes()).getByTestId("ti-project-env-stale").textContent).toMatch(
      /^Plugin environment changed\s*Hello removed CF_HELLO\.\s*Claude is still running with the old environment\. Restart Claude restarts the Claude process with the new one; the conversation continues\.$/,
    );
    setThread({});
    expect(within(screen.getByTestId("ti-project")).queryByTestId("ti-project-mark")).toBeNull();
  });
});
