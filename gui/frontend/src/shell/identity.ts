/**
 * The layout's identity table (internal/layout/identity.go), ported once for the window: what
 * makes two tabs of a kind the same tab. The host seam finds an open tab by it (shell/hostShell.ts),
 * the mock daemon keys its tabs by it (mock/layout.ts), and the menus' keys come from it
 * (shell/linked.ts). `identity.test.ts` pins the table to internal/layout/testdata/kinds.json and
 * the keys to testdata/identity.json, both written by Go's tests. Pure, layout kinds only (`file`,
 * not the panel's `files`: shell/kinds.ts maps them).
 */

export type KindLink = "self" | "required" | "optional" | "none";
export type KindScope = "space" | "global";

/** One layout kind: how its tabs link to threads and what makes two of them the same. */
export interface IdentityKind {
  link: KindLink;
  scope: KindScope;
  /** The params the key reads; every other param never changes a tab's identity. */
  keyParams?: readonly string[];
  renameable?: boolean;
  /** A family of kinds named "<name><plugin>.<surface>". */
  prefix?: boolean;
  /** The key, or a refusal: a param the key needs is missing or not one. */
  key: (t: IdentityTab) => string | Refusal;
}

/** What identity reads of a tab: its layout kind, the thread it is linked to ("" for none), its params. */
export interface IdentityTab {
  kind: string;
  thread: string;
  params: Readonly<Record<string, string>>;
}

export interface Refusal {
  refused: string;
}

const refused = (why: string): Refusal => ({ refused: why });
const isRefusal = (v: unknown): v is Refusal => typeof v === "object" && v !== null && "refused" in v;

/** The diff param naming the thread that framed the tab (view.open.diff): a tab of that thread's own, not the checkout's. */
export const DIFF_ASKER_PARAM = "thread";

function need(t: IdentityTab, ...names: string[]): string[] | Refusal {
  const out: string[] = [];
  for (const n of names) {
    const v = t.params[n] ?? "";
    if (v === "") return refused(`${t.kind} tab without param "${n}"`);
    out.push(v);
  }
  return out;
}

/** The identity key of a diff of one checkout: the checkout's own without an asker or a title. */
export function diffKey(thread: string, project: string, worktree: string, asker = "", title = ""): string {
  return `diff:${thread}:${project}:${worktree}${asker ? `:by:${asker}` : ""}${title ? `:${title}` : ""}`;
}

/** The identity key of a pull request's tab: one however its slug is spelled. */
export function prKey(slug: string, n: number | string): string {
  return `pr:${slug.toLowerCase()}#${String(n)}`;
}

export const IDENTITY_KINDS: Readonly<Record<string, IdentityKind>> = {
  thread: { link: "self", scope: "global", key: (t) => `thread:${t.thread}` },
  diff: {
    link: "optional",
    scope: "space",
    keyParams: ["project", "worktree", DIFF_ASKER_PARAM, "title"],
    key: (t) => {
      const v = need(t, "project", "worktree");
      return isRefusal(v) ? v : diffKey(t.thread, v[0] ?? "", v[1] ?? "", t.params[DIFF_ASKER_PARAM] ?? "", t.params.title ?? "");
    },
  },
  file: {
    link: "optional",
    scope: "space",
    keyParams: ["path"],
    key: (t) => {
      const v = need(t, "path");
      return isRefusal(v) ? v : `file:${v[0] ?? ""}`;
    },
  },
  pullrequest: {
    link: "optional",
    scope: "space",
    keyParams: ["slug", "number"],
    key: (t) => {
      const v = need(t, "slug", "number");
      if (isRefusal(v)) return v;
      const [slug = "", number = ""] = v;
      // strconv.Atoi's range and Itoa's spelling: no sign, no leading zero, positive.
      if (!/^[1-9]\d{0,17}$/.test(number)) return refused(`param number "${number}" is not a pull request number`);
      return prKey(slug, number);
    },
  },
  terminal: {
    link: "optional",
    scope: "global",
    keyParams: ["terminal"],
    renameable: true,
    key: (t) => {
      const v = need(t, "terminal");
      return isRefusal(v) ? v : `term:${v[0] ?? ""}`;
    },
  },
  prs: { link: "none", scope: "space", key: () => "prs" },
  projects: { link: "none", scope: "space", key: () => "projects" },
  "ember.board": { link: "required", scope: "space", key: () => "ember.board" },
  // One empty composer per space ("compose"); a draft is keyed by its id, so a space holds several.
  compose: { link: "none", scope: "space", keyParams: ["draft"], key: (t) => (t.params.draft ? `compose:draft:${t.params.draft}` : "compose") },
  mcp: { link: "required", scope: "space", key: (t) => `mcp:${t.thread}` },
  gallery: {
    link: "required",
    scope: "space",
    keyParams: ["title"],
    key: (t) => {
      const v = need(t, "title");
      return isRefusal(v) ? v : `gallery:${t.thread}:${v[0] ?? ""}`;
    },
  },
  "plugin.": {
    link: "optional",
    scope: "space",
    keyParams: ["scope"],
    prefix: true,
    key: (t) => {
      const rest = t.kind.slice("plugin.".length);
      const i = rest.indexOf(".");
      // A linked tab that names no scope is one per thread (identity.go).
      const scope = t.params.scope || (t.thread ? `thread:${t.thread}` : "");
      return `plugin:${rest.slice(0, i)}/${rest.slice(i + 1)}/${scope}`;
    },
  },
};

/** The table entry for a layout kind: an exact name, or "plugin.<plugin>.<surface>" (identity.go KindOf). */
export function identityKindOf(name: string): IdentityKind | undefined {
  if (name !== "plugin." && Object.hasOwn(IDENTITY_KINDS, name)) return IDENTITY_KINDS[name];
  if (!name.startsWith("plugin.")) return undefined;
  const rest = name.slice("plugin.".length);
  const i = rest.indexOf(".");
  return i > 0 && i < rest.length - 1 ? IDENTITY_KINDS["plugin."] : undefined;
}

/** A tab's kind and identity key, or why the layout refuses it (identity.go Identify). */
export function identify(t: IdentityTab): { kind: IdentityKind; key: string } | Refusal {
  const k = identityKindOf(t.kind);
  if (!k) return refused(`unknown tab kind "${t.kind}"`);
  if ((k.link === "self" || k.link === "required") && t.thread === "") return refused(`${t.kind} tab without a thread`);
  if (k.link === "none" && t.thread !== "") return refused(`${t.kind} tab cannot belong to a thread`);
  const key = k.key(t);
  return isRefusal(key) ? key : { kind: k, key };
}

/** A tab's identity key; null when the layout would refuse it. */
export function identityKey(kind: string, thread: string, params: Readonly<Record<string, string>>): string | null {
  const r = identify({ kind, thread, params });
  return isRefusal(r) ? null : r.key;
}

export { isRefusal };
