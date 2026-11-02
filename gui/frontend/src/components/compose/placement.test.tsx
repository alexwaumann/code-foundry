// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { draftKey, type WorktreeChoice } from "@/lib/compose";
import type { ResolvedSet } from "@/lib/projectSet";
import { updateDraft, useComposeStore } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => new Promise(() => undefined) }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));
// The collision check's own work, counted (it runs over every running thread).
const hints = vi.hoisted(() => ({ draftCheckouts: vi.fn() }));
vi.mock("@/lib/collisionHints", async (orig) => {
  const real = await orig<typeof import("@/lib/collisionHints")>();
  hints.draftCheckouts.mockImplementation(real.draftCheckouts);
  return { ...real, draftCheckouts: hints.draftCheckouts };
});

const { usePlacement } = await import("./placement");
const { Composer } = await import("./Composer");

const project = (id: string): ProjectView => ({
  id,
  path: `/src/${id}`,
  name: id,
  defaultBranch: "main",
  githubSlug: "",
  remotes: [],
  git: true,
  worktrees: [{ projectId: id, path: `/src/${id}`, branch: "main", head: "abc", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
});

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"], loaded: true });
  useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  vi.clearAllMocks();
});

describe("usePlacement's identity", () => {
  const single = (): ResolvedSet => ({ projectIds: ["web"], picked: ["web"], workspaceId: "", primary: "web", isSet: false });
  it.each<[string, () => WorktreeChoice | null]>([
    ["no pick (the setting's default)", () => null],
    ["an existing branch", () => ({ kind: "branch", name: "fix/resize" })],
    ["the project folder", () => ({ kind: "existing", path: "/src/web" })],
  ])("the same object for an equal set and pick, new each render: %s", (_, choice) => {
    const { result, rerender } = renderHook(() => usePlacement(single(), choice()));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("a new object when the pick changes", () => {
    let choice: WorktreeChoice = { kind: "new" };
    const { result, rerender } = renderHook(() => usePlacement(single(), choice));
    const first = result.current;
    choice = { kind: "branch", name: "fix/resize" };
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.pickedBranch).toBe("fix/resize");
  });
});

describe("the composer's collision check", () => {
  it("does not run again on a keystroke in the prompt", () => {
    const key = draftKey({ kind: "project", projectId: "web" });
    updateDraft(key, { worktree: { kind: "branch", name: "fix/resize" } });
    render(<Composer projectId="web" />);
    const calls = hints.draftCheckouts.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    for (const text of ["F", "Fi", "Fix"]) {
      act(() => {
        updateDraft(key, { text });
      });
    }
    expect(hints.draftCheckouts.mock.calls.length).toBe(calls);
  });
});
