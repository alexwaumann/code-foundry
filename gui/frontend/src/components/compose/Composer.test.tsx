// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoView } from "@/api/repo";
import { useComposeStore } from "@/stores/compose";
import { useReposStore } from "@/stores/repos";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Composer } from "./Composer";

// No daemon: refs and skills never load (the composer shows them loading).
vi.mock("@/api/repo", async (orig) => ({ ...(await orig<typeof import("@/api/repo")>()), listRefs: () => new Promise(() => undefined) }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));

const repo = (id: string): RepoView => ({
  id,
  path: `/src/${id}`,
  name: id,
  defaultBranch: "main",
  githubSlug: "",
  remotes: [],
  git: true,
  worktrees: [{ repoId: id, path: `/src/${id}`, branch: "main", head: "abc", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
});

beforeEach(() => {
  useReposStore.setState({ byId: { web: repo("web") }, order: ["web"], loaded: true });
  useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

describe("Composer without a project", () => {
  it("names No project and hides the worktree, base, branch and member chips", () => {
    render(<Composer repoId="" noProject />);
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build with No project?");
    expect(screen.queryByTestId("composer-worktree")).toBeNull();
    expect(screen.queryByTestId("composer-base")).toBeNull();
    expect(screen.queryByTestId("composer-members")).toBeNull();
    expect(screen.getByTestId("composer-model")).not.toBeNull();
    expect(screen.getByTestId("composer-permission").textContent).toContain("Auto");
  });

  it("a project's composer still has them", () => {
    render(<Composer repoId="web" />);
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build in web?");
    expect(screen.getByTestId("composer-worktree")).not.toBeNull();
    expect(screen.getByTestId("composer-base")).not.toBeNull();
    expect(screen.getByTestId("composer-members")).not.toBeNull();
  });
});
