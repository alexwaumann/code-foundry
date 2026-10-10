/**
 * What the Add Project dialog's GitHub input means. Mirrors the daemon's
 * gh.ParseRepoRef (internal/store/gh/reporef.go) for the repository forms, and treats
 * anything else as a search:
 *
 * - `owner/repo`, `https://github.com/owner/repo[.git]` (a trailing slash, further path,
 *   query or fragment is ignored), and `github.com/owner/repo` name one repository;
 * - SSH URLs, http://, and other hosts are refused with a message (https only, github.com
 *   only);
 * - other text is a repository search.
 */
export type GitHubInput =
  | { kind: "empty" }
  | { kind: "repo"; owner: string; name: string }
  | { kind: "search"; query: string }
  | { kind: "error"; message: string };

const ACCEPTED = "use owner/repo or https://github.com/owner/repo";

// GitHub owners: alphanumerics and single hyphens, up to 39; names also allow . and _.
const ownerRE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const nameRE = /^[A-Za-z0-9._-]{1,100}$/;

function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

function segments(path: string): string[] {
  const cut = path.search(/[?#]/);
  return (cut >= 0 ? path.slice(0, cut) : path).split("/").filter(Boolean);
}

function repoOf(owner: string, rawName: string, typed: string): GitHubInput {
  const name = rawName.replace(/\.git$/, "");
  if (!ownerRE.test(owner) || !nameRE.test(name) || name === "." || name === "..") {
    return { kind: "error", message: `"${typed}" is not a valid owner/repo` };
  }
  return { kind: "repo", owner, name };
}

export function parseGitHubInput(input: string): GitHubInput {
  const s = input.trim();
  if (s === "") return { kind: "empty" };
  if (s.startsWith("git@") || /^ssh:\/\//i.test(s)) return { kind: "error", message: `SSH URLs are not supported; ${ACCEPTED}` };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    if (scheme[1]?.toLowerCase() !== "https") return { kind: "error", message: `Only https:// URLs are supported; ${ACCEPTED}` };
    const rest = scheme[2] ?? "";
    const slash = rest.indexOf("/");
    const host = (slash >= 0 ? rest.slice(0, slash) : rest).replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    if (!isGitHubHost(host)) return { kind: "error", message: `Only github.com repositories are supported, not ${host || "this URL"}` };
    const segs = segments(slash >= 0 ? rest.slice(slash) : "");
    const [owner, name] = segs;
    if (owner === undefined || name === undefined) return { kind: "error", message: `That URL does not name a repository; ${ACCEPTED}` };
    return repoOf(owner, name, `${owner}/${name}`);
  }
  if (/\s/.test(s)) return { kind: "search", query: s };
  const segs = segments(s);
  const [first] = segs;
  if (segs.length >= 2 && first?.includes(".")) {
    // "github.com/owner/repo": a URL without its scheme.
    if (!isGitHubHost(first)) return { kind: "error", message: `Only github.com repositories are supported, not ${first}` };
    const [, owner, name] = segs;
    if (owner === undefined || name === undefined) return { kind: "error", message: `That URL does not name a repository; ${ACCEPTED}` };
    return repoOf(owner, name, `${owner}/${name}`);
  }
  if (segs.length === 2 && /^[^/]+\/[^/]+$/.test(s)) {
    const [owner = "", name = ""] = segs;
    // Only a well-formed pair is a lookup; "c++/rust" and the like stay a search.
    if (ownerRE.test(owner) && nameRE.test(name.replace(/\.git$/, ""))) return repoOf(owner, name, s);
  }
  return { kind: "search", query: s };
}
