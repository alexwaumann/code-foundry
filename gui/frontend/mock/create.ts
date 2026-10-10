/**
 * RepoService.Create, ListPublishOwners and Publish, and the repo.create and
 * repo.github.publish commands (the Add Project dialog's New tab and the publish dialog).
 *
 * - Create makes a git project on main at ~/.code-foundry/projects/<name>; the daemon's
 *   name rules (src/lib/publish.ts); a name taken by any project path is AlreadyExists.
 * - ListPublishOwners: the user "dev" (Public/Private), "octo-org" with a known policy
 *   (Public and Internal only), "acme" whose policy GitHub does not show (all three).
 * - Publish takes ~400ms. It fails like gh when the visibility is private for octo-org
 *   or the name is "taken"; otherwise the project gets origin and the dev/<name> slug.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { PublishOwnerKind, RepositoryVisibility, type PublishOwnerSchema } from "../src/gen/codefoundry/v1/repo_pb";
import { projectNameError } from "../src/lib/publish";
import { PROJECTS } from "./clone";
import type { InvokeOut } from "./gitops";

type PublishOwnerInit = MessageInitShape<typeof PublishOwnerSchema>;

const { PUBLIC, INTERNAL, PRIVATE } = RepositoryVisibility;

export const publishOwners: PublishOwnerInit[] = [
  { login: "dev", kind: PublishOwnerKind.USER, allowed: [PUBLIC, PRIVATE], known: true },
  { login: "acme", kind: PublishOwnerKind.ORGANIZATION, allowed: [PUBLIC, INTERNAL, PRIVATE], known: false },
  { login: "octo-org", kind: PublishOwnerKind.ORGANIZATION, allowed: [PUBLIC, INTERNAL], known: true },
];

/** gh's errors for the refusals the mock plays. */
export const GH_PRIVATE_REFUSED =
  "GraphQL: Repository creation failed: Private repositories are disabled for this organization. Visibility must be public or internal. (createRepository)";
export const GH_NAME_TAKEN = "GraphQL: Name already exists on this account (createRepository)";

/** What World offers this module (mock/world.ts). */
export interface ProjectWorld {
  projectPaths(): string[];
  repoInfo(id: string): { name: string; git: boolean; remotes: string[] } | undefined;
  addCreated(name: string, path: string): { id: string; name: string; path: string };
  setOrigin(id: string, slug: string): void;
}

/** Every Create and Publish ("create <name>", "publish <id> <owner>/<name> <visibility>"). */
export const projectCalls: string[] = [];

export function resetProjects(): void {
  projectCalls.length = 0;
}

export function listPublishOwners(): { owners: PublishOwnerInit[] } {
  return { owners: publishOwners };
}

/** RepoService.Create and repo.create. */
export function createProject(world: ProjectWorld, name: string): { id: string; name: string; path: string } {
  projectCalls.push(`create ${name}`);
  const why = projectNameError(name);
  if (why) throw new ConnectError(`invalid argument: ${why}`, Code.InvalidArgument);
  const path = `${PROJECTS}/${name}`;
  if (world.projectPaths().some((p) => p.toLowerCase() === path.toLowerCase())) throw new ConnectError(`${path} already exists`, Code.AlreadyExists);
  return world.addCreated(name, path);
}

const visibilityNames: Record<string, string> = { public: "public", internal: "internal", private: "private" };

/** The proto visibility as gh's flag spells it ("" for UNSPECIFIED). */
export function visibilityFlag(v: RepositoryVisibility): string {
  switch (v) {
    case PUBLIC:
      return "public";
    case INTERNAL:
      return "internal";
    case PRIVATE:
      return "private";
    default:
      return "";
  }
}

/** RepoService.Publish and repo.github.publish. */
export async function publishProject(world: ProjectWorld, repoId: string, owner: string, name: string, visibility: string): Promise<{ name: string; slug: string }> {
  const repo = world.repoInfo(repoId);
  if (!repo) throw new ConnectError(`project not found: "${repoId}"`, Code.NotFound);
  const ghName = name || repo.name;
  const vis = visibilityNames[visibility.toLowerCase()];
  projectCalls.push(`publish ${repoId} ${owner}/${ghName} ${visibility}`);
  if (!vis) throw new ConnectError(`invalid argument: visibility "${visibility}" (want public, internal or private)`, Code.InvalidArgument);
  if (!owner) throw new ConnectError("invalid argument: a GitHub owner is required", Code.InvalidArgument);
  if (!repo.git) throw new ConnectError(`failed precondition: ${repo.name} is not a git repository; initialize git first`, Code.FailedPrecondition);
  if (repo.remotes.includes("origin")) throw new ConnectError(`failed precondition: ${repo.name} already has an origin remote`, Code.FailedPrecondition);
  await new Promise((r) => setTimeout(r, 400));
  if (owner === "octo-org" && vis === "private") throw new ConnectError(GH_PRIVATE_REFUSED, Code.Unknown);
  if (ghName.toLowerCase() === "taken") throw new ConnectError(GH_NAME_TAKEN, Code.Unknown);
  const slug = `${owner}/${ghName}`;
  world.setOrigin(repoId, slug);
  return { name: repo.name, slug };
}

interface CommandEntry {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    args: { name: string; type: ArgType; required: boolean; description: string; enumValues?: string[] }[];
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
}

/** repo.create and repo.github.publish, as internal/command/commands_repo_create.go. */
export function projectCommands(world: ProjectWorld): CommandEntry[] {
  const publishable = (id: string): boolean => {
    const r = world.repoInfo(id);
    return r !== undefined && r.git && !r.remotes.includes("origin");
  };
  return [
    {
      cmd: {
        name: "repo.create",
        title: "New Project",
        category: "Project",
        description:
          "Start an empty project in ~/.code-foundry/projects/<name>: git init on the default branch (init.defaultBranch, else main) and an empty initial commit. Refuses when that folder exists.",
        keybindings: [],
        args: [{ name: "name", type: ArgType.STRING, required: true, description: "Folder name: letters, digits, -, _ and . (not starting with .)" }],
      },
      when: () => true,
      run: (_ctx, args) => {
        const r = createProject(world, args.name ?? "");
        return Promise.resolve({ message: `created ${r.name} in ${r.path} (${r.id})`, resultJson: JSON.stringify({ id: r.id, name: r.name, path: r.path, git: true }) });
      },
    },
    {
      cmd: {
        name: "repo.github.publish",
        title: "Publish to GitHub",
        category: "Project",
        description:
          "Create a GitHub repository for a git project without an origin remote and push it, with `gh repo create <owner>/<name> --source <project> --remote origin --push`. Organizations may refuse some visibilities; gh's error is shown as is.",
        keybindings: [],
        args: [
          { name: "repo", type: ArgType.STRING, required: true, description: "Repository id" },
          { name: "owner", type: ArgType.STRING, required: true, description: "GitHub user or organization" },
          { name: "name", type: ArgType.STRING, required: false, description: "Repository name on GitHub (default: the project's name)" },
          { name: "visibility", type: ArgType.ENUM, required: true, description: "Repository visibility", enumValues: ["public", "internal", "private"] },
        ],
      },
      when: (ctx) => publishable(ctx?.activeRepoId ?? ""),
      run: async (ctx, args) => {
        const id = args.repo || ctx?.activeRepoId || "";
        const vis = args.visibility ?? "";
        const r = await publishProject(world, id, args.owner ?? "", args.name ?? "", vis);
        return { message: `published ${r.name} to https://github.com/${r.slug} (${vis})`, resultJson: JSON.stringify({ id, name: r.name, githubSlug: r.slug, remotes: ["origin"], git: true }) };
      },
    },
  ];
}
