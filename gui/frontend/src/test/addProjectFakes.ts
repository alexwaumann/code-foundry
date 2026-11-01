/**
 * The daemon's side of the Add Project and Publish dialogs for component tests, as the mock
 * daemon has it (mock/filesystem.ts, mock/clone.ts, mock/create.ts): the folder tree under
 * /Users/dev that path completion lists, ProjectService.Register and InspectFolder, the
 * GitHub repositories to look up, search and clone, and the owners to publish to. Wire it in
 * with vi.mock, spreading the fakes over the real modules (src/test/daemonFakes.ts shows how).
 * Nothing here imports a store or a mocked module.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { AddedProjectView, CloneProgressView, FolderInfoView, GitHubRepoView } from "@/api/addProject";
import type { DirectoryListingView } from "@/api/filesystem";
import type { ProjectView } from "@/api/project";
import type { PublishOwnersResult } from "@/api/publish";

const HOME = "/Users/dev";
export const PROJECTS = `${HOME}/.code-foundry/projects`;

interface Dir {
  git?: boolean;
  children?: Record<string, Dir>;
}

const tree: Dir = {
  children: {
    src: {
      children: {
        "code-foundry": { git: true, children: { src: {}, docs: {} } },
        "ghostty-playground": { git: true },
        sketches: { git: true },
        "new-app": { git: true, children: { web: {}, api: {} } },
        Notebook: {},
        Website: { git: true },
      },
    },
    dotfiles: { git: true },
    product: { children: { web: { git: true }, api: { git: true }, "docs-site": { git: true }, notes: {} } },
    mixed: { children: { ok: { git: true }, broken: { git: true } } },
    Documents: { children: { Projects: { children: { "side-project": { git: true } } } } },
    Downloads: {},
  },
};

/** The folders the world has as projects, by path (their listing rows say "already added"). */
const INITIAL: [string, AddedProjectView][] = [
  [`${HOME}/src/code-foundry`, { id: "repo-cf", name: "code-foundry" }],
  [`${HOME}/src/ghostty-playground`, { id: "repo-gp", name: "ghostty-playground" }],
  [`${HOME}/src/sketches`, { id: "repo-sk", name: "sketches" }],
  [`${HOME}/dotfiles`, { id: "repo-dot", name: "dotfiles" }],
];
const registered = new Map(INITIAL);

const abs = (p: string) => (p.startsWith("~") ? `${HOME}${p.slice(1)}` : p).replace(/\/+$/, "") || "/";

function node(path: string): Dir | undefined {
  const rel = abs(path).slice(HOME.length).split("/").filter(Boolean);
  let d: Dir | undefined = tree;
  for (const part of rel) d = d?.children?.[part];
  return d;
}

const repos: { owner: string; name: string; description?: string; archived?: boolean }[] = [
  { owner: "alexwaumann", name: "dotfiles", description: "My configuration files" },
  { owner: "octo-org", name: "fail", description: "A repository whose clone fails (mock)" },
  { owner: "octo-org", name: "already-here", description: "Its destination folder exists already (mock)" },
  { owner: "octo-org", name: "legacy-api", description: "The old API, kept for reference", archived: true },
  { owner: "octo-org", name: "Hello-World", description: "My first repository on GitHub!" },
];

const noop: (p: ProjectView) => void = () => undefined;

export const fakeDaemon = {
  /** What the dialogs asked: "register <path>", "inspect <path>", "lookup o/n", "search q", "clone o/n", "owners". */
  calls: [] as string[],
  cloned: new Set<string>(),
  /** Runs when Register or Clone adds a project (the test puts it in the projects store, as its event would). */
  onAdded: noop,
};

export function resetAddProjectFakes(): void {
  fakeDaemon.calls.length = 0;
  fakeDaemon.cloned.clear();
  fakeDaemon.onAdded = noop;
  registered.clear();
  for (const [path, p] of INITIAL) registered.set(path, p);
}

function view(abspath: string, git: boolean, id = `repo-${abspath.slice(abspath.lastIndexOf("/") + 1).toLowerCase()}`): ProjectView {
  const name = abspath.slice(abspath.lastIndexOf("/") + 1);
  return { id, path: abspath, name, defaultBranch: git ? "main" : "", githubSlug: "", remotes: [], git, worktrees: [] };
}

function repoView(r: (typeof repos)[number]): GitHubRepoView {
  const clonePath = `${PROJECTS}/${r.owner}/${r.name}`;
  return {
    owner: r.owner,
    name: r.name,
    slug: `${r.owner}/${r.name}`,
    description: r.description ?? "",
    visibility: "public",
    archived: r.archived ?? false,
    fork: false,
    url: `https://github.com/${r.owner}/${r.name}`,
    clonePath,
    clonePathExists: r.name === "already-here" || fakeDaemon.cloned.has(clonePath),
  };
}

export const filesystemFakes = {
  listDirectories: (prefix: string): Promise<DirectoryListingView> => {
    const p = prefix.replace(/^~\/?/, "");
    const i = p.lastIndexOf("/");
    const dir = node(`~/${i < 0 ? "" : p.slice(0, i)}`);
    const part = i < 0 ? p : p.slice(i + 1);
    const names = Object.keys(dir?.children ?? {})
      .filter((n) => n.startsWith(part))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const base = `${HOME}/${i < 0 ? "" : `${p.slice(0, i)}/`}`;
    const entries = names.map((name) => ({ path: `${base}${name}`, name, isGit: dir?.children?.[name]?.git === true, registered: registered.has(`${base}${name}`) }));
    let common = names[0] ?? "";
    for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
    // One match completes to the folder itself, a slash after it (as the daemon does).
    const typedDir = i < 0 ? "" : p.slice(0, i + 1);
    const completion = names.length === 1 ? `${typedDir}${common}/` : `${typedDir}${common}`;
    return Promise.resolve({ entries, completion, truncated: false });
  },
};

export const addProjectApiFakes = {
  registerProject: (path: string): Promise<AddedProjectView> => {
    fakeDaemon.calls.push(`register ${path}`);
    const full = abs(path);
    // A folder inside a project (or the project's own): that project.
    for (const [r, added] of registered) if (full === r || full.startsWith(`${r}/`)) return Promise.resolve(added);
    // A clone's destination exists on disk (mock/clone.ts).
    const d = full.startsWith(`${PROJECTS}/`) ? { git: true } : node(full);
    if (!d) return Promise.reject(new ConnectError(`stat ${full}: no such file or directory`, Code.InvalidArgument));
    const p = view(full, d.git === true);
    registered.set(full, { id: p.id, name: p.name });
    fakeDaemon.onAdded(p);
    return Promise.resolve({ id: p.id, name: p.name });
  },
  inspectFolder: (path: string): Promise<FolderInfoView> => {
    fakeDaemon.calls.push(`inspect ${path}`);
    const full = abs(path);
    const d = node(full);
    const childRepos = Object.entries(d?.children ?? {})
      .filter(([, c]) => c.git === true)
      .map(([name]) => ({ path: `${full}/${name}`, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Promise.resolve({ path: full, isRepo: d?.git === true, childRepos });
  },
  lookupGitHub: (owner: string, name: string): Promise<GitHubRepoView | null> => {
    fakeDaemon.calls.push(`lookup ${owner}/${name}`);
    const r = repos.find((x) => x.owner.toLowerCase() === owner.toLowerCase() && x.name.toLowerCase() === name.toLowerCase());
    return Promise.resolve(r ? repoView(r) : null);
  },
  searchGitHub: (query: string): Promise<GitHubRepoView[]> => {
    fakeDaemon.calls.push(`search ${query}`);
    const q = query.toLowerCase();
    return Promise.resolve(repos.filter((r) => `${r.owner}/${r.name} ${r.description ?? ""}`.toLowerCase().includes(q)).map(repoView));
  },
  cloneRepo: async (owner: string, name: string, onProgress: (p: CloneProgressView) => void): Promise<ProjectView> => {
    fakeDaemon.calls.push(`clone ${owner}/${name}`);
    const dest = `${PROJECTS}/${owner}/${name}`;
    const lines: CloneProgressView[] = [
      { line: `Cloning into '${dest}'...`, transient: false },
      { line: "remote: Enumerating objects: 128, done.", transient: false },
      { line: "Receiving objects:  46% (59/128)", transient: true },
    ];
    for (const [i, l] of lines.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, 30));
      onProgress(l);
    }
    if (name === "fail") throw new ConnectError("fatal: early EOF\nfatal: fetch-pack: invalid index-pack output", Code.Unknown);
    onProgress({ line: "Receiving objects: 100% (128/128), done.", transient: false });
    fakeDaemon.cloned.add(dest);
    const p = { ...view(dest, true, `repo-${name.toLowerCase()}`), name };
    fakeDaemon.onAdded(p);
    return p;
  },
};

export const GH_NAME_TAKEN = "GraphQL: Name already exists on this account (createRepository)";

export const publishFakes = {
  listPublishOwners: (): Promise<PublishOwnersResult> => {
    fakeDaemon.calls.push("owners");
    return Promise.resolve({
      owners: [
        { login: "dev", kind: "user", allowed: ["public", "private"], known: true },
        { login: "acme", kind: "org", allowed: ["public", "internal", "private"], known: false },
        { login: "octo-org", kind: "org", allowed: ["public", "internal"], known: true },
      ],
      stale: false,
    });
  },
};
