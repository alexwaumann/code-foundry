import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { projectKind, type ProjectKind } from "@/lib/projects";
import { useProjectsStore } from "@/stores/projects";
import { GithubProjectMark } from "./GithubProjectMark";
import { PROJECT_KIND_ICONS } from "./projectKind";
import { ProjectIcon, ProjectKindIcon } from "./ProjectKindIcon";
import { Folder, FolderGit2 } from "lucide-react";

/** The one glyph per project kind (docs/notes/icon-system.md). */

afterEach(() => {
  cleanup();
  useProjectsStore.setState({ byId: {}, order: [] });
});

const svg = (el: HTMLElement) => el.querySelector("svg");

describe("ProjectKindIcon", () => {
  it.each<[string, Parameters<typeof projectKind>[0], ProjectKind, unknown]>([
    ["a GitHub repository: the GitHub mark", { githubSlug: "acme/web", remotes: ["origin"] }, "github", GithubProjectMark],
    ["a remote elsewhere: FolderGit2", { githubSlug: "", remotes: ["origin"] }, "git", FolderGit2],
    ["no remote: FolderGit2", { githubSlug: "", remotes: [] }, "git", FolderGit2],
    ["no git: Folder", { githubSlug: "", remotes: [], git: false }, "nogit", Folder],
  ])("%s", (_, project, kind, icon) => {
    expect(projectKind(project).kind).toBe(kind);
    expect(PROJECT_KIND_ICONS[kind]).toBe(icon);
    const { container } = render(<ProjectKindIcon kind={kind} className="size-4 text-cf-text-muted" />);
    expect(svg(container)?.getAttribute("data-project-kind")).toBe(kind);
    expect(svg(container)?.getAttribute("aria-hidden")).toBe("true");
  });

  it("tints the GitHub mark info and leaves the folder kinds to the caller's colour", () => {
    const gh = render(<ProjectKindIcon kind="github" className="text-cf-text-muted" />).container;
    expect(svg(gh)?.getAttribute("class")).toContain("text-cf-info-text/90");
    const git = render(<ProjectKindIcon kind="git" className="text-cf-text-muted" />).container;
    expect(svg(git)?.getAttribute("class")).toContain("text-cf-text-muted");
    expect(svg(git)?.getAttribute("class")).not.toContain("text-cf-info-text");
  });

  it("ProjectIcon reads the kind from the projects store; an unknown project is a git folder", () => {
    useProjectsStore.setState({
      byId: { web: { id: "web", githubSlug: "acme/web", remotes: ["origin"], git: true } as never, notes: { id: "notes", githubSlug: "", remotes: [], git: false } as never },
    });
    const kindOf = (id: string) => svg(render(<ProjectIcon projectId={id} />).container)?.getAttribute("data-project-kind");
    expect(kindOf("web")).toBe("github");
    expect(kindOf("notes")).toBe("nogit");
    expect(kindOf("gone")).toBe("git");
  });
});
