/**
 * FilesystemService over a fake home directory, mirroring internal/fsx: "~" expansion,
 * case-insensitive prefix match, dot-directories only for a "." segment, a 200-entry
 * bound, and InvalidArgument outside home. The tree holds the mock's registered repos
 * (world.ts) plus a few unregistered folders to add.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ListDirectoriesResponseSchema } from "../src/gen/codefoundry/v1/filesystem_pb";

export const HOME = "/Users/dev";
const MAX_ENTRIES = 200;

/** A directory: children by name. `git` marks a .git entry inside. */
interface Dir {
  git?: boolean;
  children?: Record<string, Dir>;
}

const repo: Dir = { git: true, children: { src: {}, docs: {} } };

const tree: Dir = {
  children: {
    src: {
      children: {
        "code-foundry": repo,
        "code-foundry.worktrees": { children: { "feat-sidebar": { git: true }, "fix-resize": { git: true } } },
        "ghostty-playground": { git: true },
        sketches: { git: true },
        "new-app": { git: true, children: { web: {}, api: {} } },
        Notebook: {},
        Website: { git: true },
      },
    },
    dotfiles: { git: true },
    Documents: { children: { Projects: { children: { "side-project": { git: true } } } } },
    Downloads: {},
    Library: {},
    many: { children: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`d${String(i).padStart(3, "0")}`, {}])) },
    ".config": { children: { nvim: { git: true } } },
    ".ssh": {},
  },
};

type ListingInit = MessageInitShape<typeof ListDirectoriesResponseSchema>;

function invalid(msg: string): ConnectError {
  return new ConnectError(`invalid argument: ${msg}`, Code.InvalidArgument);
}

/** Resolves an absolute path ("/Users/dev/src") to its node, or undefined. */
function lookup(abs: string): Dir | undefined {
  if (abs === HOME) return tree;
  if (!abs.startsWith(`${HOME}/`)) return undefined;
  let node: Dir | undefined = tree;
  for (const seg of abs.slice(HOME.length + 1).split("/")) {
    if (seg === "") continue;
    node = node?.children?.[seg];
  }
  return node;
}

/** Normalizes "." and ".." segments of an absolute path. */
function clean(abs: string): string {
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function within(path: string): boolean {
  return path.toLowerCase() === HOME.toLowerCase() || path.toLowerCase().startsWith(`${HOME.toLowerCase()}/`);
}

function commonFoldPrefix(names: string[]): string {
  const first = names[0] ?? "";
  let n = first.length;
  for (const other of names.slice(1)) {
    let i = 0;
    while (i < n && i < other.length && first[i]?.toLowerCase() === other[i]?.toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n);
}

export function listDirectories(rawPrefix: string, registered: ReadonlySet<string>): ListingInit {
  const prefix = rawPrefix === "" || rawPrefix === "~" ? "~/" : rawPrefix;
  let abs: string;
  if (prefix.startsWith("~/")) abs = HOME + prefix.slice(1);
  else if (prefix.startsWith("~")) throw invalid(`~user paths are not supported: "${prefix}"`);
  else if (!prefix.startsWith("/")) throw invalid(`want an absolute path or one starting with ~, got "${prefix}"`);
  else abs = prefix;
  const typedDir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  const base = prefix.slice(prefix.lastIndexOf("/") + 1);
  const dir = clean(abs.slice(0, abs.lastIndexOf("/") + 1));
  if (!within(dir)) throw invalid(`${prefix} is outside your home directory`);
  const node = lookup(dir);
  const empty: ListingInit = { entries: [], completion: prefix, truncated: false };
  if (!node?.children) return empty;

  const showDot = base.startsWith(".");
  const names = Object.keys(node.children)
    .filter((n) => (showDot || !n.startsWith(".")) && n.toLowerCase().startsWith(base.toLowerCase()))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  if (names.length === 0) return empty;
  const completion = names.length === 1 ? `${typedDir}${names[0] ?? ""}/` : typedDir + commonFoldPrefix(names);
  const shown = names.slice(0, MAX_ENTRIES);
  return {
    entries: shown.map((name) => {
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      return { path, name, isGit: node.children?.[name]?.git === true, registered: registered.has(path) };
    }),
    completion,
    truncated: names.length > MAX_ENTRIES,
  };
}
