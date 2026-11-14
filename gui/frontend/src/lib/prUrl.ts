/**
 * The GitHub pull request a URL is the page of, for links that open in a tab
 * (components/pr/prLinks.ts): `http(s)://github.com/<owner>/<repo>/pull/<n>`, also
 * `www.github.com` (any case), with an optional tab (`/files`, `/commits`, `/checks`,
 * `/changes`), a trailing slash, a query and a fragment (`#discussion_r1`,
 * `#issuecomment-2`). Issues, commits, compare views, other hosts, and owners or names
 * GitHub would not accept are null.
 */
export interface PullRequestUrl {
  slug: string;
  number: number;
  /** The link points into the page: a tab (`/files`, …) or a fragment (a comment, a diff line). */
  anchored: boolean;
}

// GitHub owners: alphanumerics and hyphens, starting alphanumeric, up to 39 (lib/githubRef, looser than
// GitHub's no-double-hyphen rule; harmless here); names also allow . and _.
const ownerRE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const nameRE = /^[A-Za-z0-9._-]{1,100}$/;
const numberRE = /^[1-9][0-9]{0,9}$/;
const TABS = new Set(["files", "commits", "checks", "changes"]);

export function parsePullRequestUrl(href: string): PullRequestUrl | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // URL lower-cases the host; a port or credentials make it some other page.
  if ((u.hostname !== "github.com" && u.hostname !== "www.github.com") || u.port !== "" || u.username !== "" || u.password !== "") return null;
  const segs = u.pathname.split("/");
  // "", owner, repo, "pull", n, then a tab and/or "" (a trailing slash).
  if (segs[0] !== "") return null;
  const [, owner = "", name = "", pull, num = "", ...rest] = segs;
  if (pull !== "pull" || !ownerRE.test(owner) || !nameRE.test(name) || name === "." || name === ".." || !numberRE.test(num)) return null;
  const tail = rest.at(-1) === "" ? rest.slice(0, -1) : rest;
  if (tail.length > 1 || (tail.length === 1 && !TABS.has(tail[0] ?? ""))) return null;
  const number = Number(num);
  if (!Number.isSafeInteger(number)) return null;
  return { slug: `${owner}/${name}`, number, anchored: tail.length === 1 || u.hash.length > 1 };
}
