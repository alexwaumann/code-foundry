/**
 * RepoService.SearchGitHub, LookupGitHub and Clone over a fixed set of GitHub
 * repositories (the Add Project dialog's GitHub tab).
 *
 * - Search matches owner/name and description, case-insensitively, at most 20.
 * - Lookup is case-insensitive and answers GitHub's spelling; anything else is NotFound.
 * - Clone streams five progress lines over ~1.5s (one transient), then registers the
 *   clone (world.addClone) and ends with it. A repository named "fail" fails after three
 *   lines with gh's last lines as the message; a destination that exists
 *   (octo-org/already-here, or anything cloned before) is AlreadyExists.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { RepositoryVisibility, type CloneRepoEventSchema, type GitHubRepositorySchema } from "../src/gen/codefoundry/v1/repo_pb";
import { HOME } from "./filesystem";
import type { World } from "./world";

type GitHubRepoInit = MessageInitShape<typeof GitHubRepositorySchema>;
type CloneEventInit = MessageInitShape<typeof CloneRepoEventSchema>;

export const PROJECTS = `${HOME}/.code-foundry/projects`;

interface Fixture {
  owner: string;
  name: string;
  description?: string;
  visibility?: RepositoryVisibility;
  archived?: boolean;
  fork?: boolean;
}

const fixtures: Fixture[] = [
  { owner: "alexwaumann", name: "code-foundry", description: "Desktop app for running fleets of Claude Code sessions across git worktrees" },
  { owner: "alexwaumann", name: "dotfiles", description: "My configuration files" },
  { owner: "alexwaumann", name: "quest-board", description: "Side quests, tracked", visibility: RepositoryVisibility.PRIVATE },
  { owner: "octo-org", name: "fail", description: "A repository whose clone fails (mock)" },
  { owner: "octo-org", name: "already-here", description: "Its destination folder exists already (mock)" },
  { owner: "octo-org", name: "legacy-api", description: "The old API, kept for reference", visibility: RepositoryVisibility.INTERNAL, archived: true },
  { owner: "octo-org", name: "Hello-World", description: "My first repository on GitHub!" },
  { owner: "ghostty-org", name: "ghostty", description: "Ghostty is a fast, feature-rich, and cross-platform terminal emulator" },
  { owner: "cli", name: "cli", description: "GitHub’s official command line tool" },
  { owner: "charmbracelet", name: "bubbletea", description: "A powerful little TUI framework" },
  { owner: "dev", name: "cli-fork", description: "A fork of cli/cli", fork: true },
  { owner: "connectrpc", name: "connect-go", description: "The Go implementation of Connect: Protobuf RPC that works" },
];

/** Destinations that exist on the mock's disk (clones add theirs). */
const existing = new Set<string>();

/** Every SearchGitHub, LookupGitHub and Clone call ("search <q>", ...), for tests. */
export const githubCalls: string[] = [];

export function resetClones(): void {
  githubCalls.length = 0;
  existing.clear();
  existing.add(`${PROJECTS}/octo-org/already-here`.toLowerCase());
}
resetClones();

function destination(owner: string, name: string): string {
  return `${PROJECTS}/${owner}/${name}`;
}

function toMsg(f: Fixture): GitHubRepoInit {
  const path = destination(f.owner, f.name);
  return {
    owner: f.owner,
    name: f.name,
    description: f.description ?? "",
    visibility: f.visibility ?? RepositoryVisibility.PUBLIC,
    isArchived: f.archived ?? false,
    isFork: f.fork ?? false,
    url: `https://github.com/${f.owner}/${f.name}`,
    clonePath: path,
    clonePathExists: existing.has(path.toLowerCase()),
  };
}

export function searchGitHub(query: string): { repositories: GitHubRepoInit[] } {
  githubCalls.push(`search ${query}`);
  const q = query.trim().toLowerCase();
  if (!q) throw new ConnectError("invalid argument: empty search", Code.InvalidArgument);
  const hits = fixtures.filter((f) => `${f.owner}/${f.name} ${f.description ?? ""}`.toLowerCase().includes(q));
  return { repositories: hits.slice(0, 20).map(toMsg) };
}

function find(owner: string, name: string): Fixture | undefined {
  return fixtures.find((f) => f.owner.toLowerCase() === owner.toLowerCase() && f.name.toLowerCase() === name.toLowerCase());
}

export function lookupGitHub(owner: string, name: string): { repository: GitHubRepoInit } {
  githubCalls.push(`lookup ${owner}/${name}`);
  const f = find(owner, name);
  if (!f) throw new ConnectError(`not found on github: Could not resolve to a Repository with the name '${owner}/${name}'.`, Code.NotFound);
  return { repository: toMsg(f) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ConnectError("clone cancelled", Code.Canceled));
    });
  });
}

const progress = (line: string, transient = false): CloneEventInit => ({ event: { case: "progress", value: { line, transient } } });

export async function* cloneRepo(world: World, owner: string, name: string, signal: AbortSignal): AsyncGenerator<CloneEventInit> {
  githubCalls.push(`clone ${owner}/${name}`);
  const f = find(owner, name);
  const dest = destination(f?.owner ?? owner, f?.name ?? name);
  if (existing.has(dest.toLowerCase())) throw new ConnectError(`${dest} already exists`, Code.AlreadyExists);
  const lines = [
    progress(`Cloning into '${dest}'...`),
    progress("remote: Enumerating objects: 128, done."),
    progress("Receiving objects:  46% (59/128)", true),
    progress("Receiving objects: 100% (128/128), 42.10 KiB | 2.10 MiB/s, done."),
    progress("Resolving deltas: 100% (37/37), done."),
  ];
  if (!f) {
    await sleep(300, signal);
    yield progress(`GraphQL: Could not resolve to a Repository with the name '${owner}/${name}'. (repository)`);
    throw new ConnectError(`repository not found on github: Could not resolve to a Repository with the name '${owner}/${name}'.`, Code.NotFound);
  }
  const failing = name.toLowerCase() === "fail";
  for (const [i, ev] of lines.entries()) {
    if (failing && i === 3) {
      await sleep(300, signal);
      throw new ConnectError("gh repo clone failed: error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly\nfatal: early EOF", Code.Unknown);
    }
    await sleep(300, signal);
    yield ev;
  }
  existing.add(dest.toLowerCase());
  yield { event: { case: "repo", value: world.repoMsg(world.addClone(f.owner, f.name, dest)) } };
}
