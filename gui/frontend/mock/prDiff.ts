/**
 * Mock GhService pull request diff and files (GetPullRequestDiff, GetPullRequestFile)
 * for the PR panel's Code tab. Every pull request has the same three-file diff (git
 * diff -M of real files): a modified TypeScript file with four hunks, a renamed note with
 * one changed line, and an added binary. GetPullRequestFile serves those files at the
 * head of a diff it served (the new side) and at any other commit (the old side), so expanding
 * unchanged lines works. #140's diff is refused as too large (FAILED_PRECONDITION with
 * GitHub's message), like the daemon relays it. Both count in /__mock/gh/calls
 * ("GetPullRequestDiff", "GetPullRequestDiff refresh", "GetPullRequestFile <path>").
 */
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { GetPullRequestDiffResponseSchema, GetPullRequestFileResponseSchema } from "../src/gen/codefoundry/v1/gh_pb";

export interface PrDiffHooks {
  /** The pull request's head and base commits; null when there is no such pull request. */
  shas: (slug: string, number: number) => { head: string; base: string } | null;
  count: (rpc: string) => void;
}

const TOO_LARGE = 140;
const TOO_LARGE_MESSAGE = "Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead.";

export const PR_DIFF = `diff --git a/docs/notes/greeting.md b/docs/notes/welcome-greeting.md
similarity index 86%
rename from docs/notes/greeting.md
rename to docs/notes/welcome-greeting.md
index 9b3fdc6..c849c77 100644
--- a/docs/notes/greeting.md
+++ b/docs/notes/welcome-greeting.md
@@ -1,4 +1,4 @@
-# Old name
+# Welcome greeting
 
 The welcome screen greets the viewer.
 
diff --git a/gui/frontend/public/logo.png b/gui/frontend/public/logo.png
new file mode 100644
index 0000000..029ace0
Binary files /dev/null and b/gui/frontend/public/logo.png differ
diff --git a/gui/frontend/src/lib/greeting.ts b/gui/frontend/src/lib/greeting.ts
index ec4e389..55a0812 100644
--- a/gui/frontend/src/lib/greeting.ts
+++ b/gui/frontend/src/lib/greeting.ts
@@ -1,5 +1,6 @@
 /**
- * Greetings for the welcome screen: one per time of day, in the user's locale.
+ * Greetings for the welcome screen: one per time of day, in the user's locale,
+ * with the viewer's first name when GitHub knows it.
  */
 import { useNow } from "./clock";
 
@@ -19,6 +20,7 @@ const TEXT: Record<DayPart, string> = {
 
 /** The part of the day an hour (0-23) falls in. */
 export function dayPart(hour: number): DayPart {
+  if (hour < 0 || hour > 23) throw new RangeError(\`hour \${String(hour)}\`);
   if (hour < 5) return "night";
   if (hour < 12) return "morning";
   if (hour < 18) return "afternoon";
@@ -39,8 +41,8 @@ export function withName(g: Greeting, name: string): string {
 
 /** The first name of a full name, or the login when there is none. */
 export function firstName(full: string, login: string): string {
-  const first = full.trim().split(/\\s+/)[0];
-  return first || login;
+  const [first = ""] = full.trim().split(/\\s+/);
+  return first === "" ? login : first;
 }
 
 /** Greets the viewer, refreshed every minute. */
@@ -54,7 +56,7 @@ export const SHORT: Record<DayPart, string> = {
   morning: "Morning",
   afternoon: "Afternoon",
   evening: "Evening",
-  night: "Late",
+  night: "Late night",
 };
 
 /** The short greeting for a moment. */
`;

/** Each path's new (head) and old contents; null for a side without the file. */
const FILES: Record<string, { head: string | Uint8Array | null; base: string | null }> = {
  "gui/frontend/src/lib/greeting.ts": {
    head: `/**
 * Greetings for the welcome screen: one per time of day, in the user's locale,
 * with the viewer's first name when GitHub knows it.
 */
import { useNow } from "./clock";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export interface Greeting {
  part: DayPart;
  text: string;
}

const TEXT: Record<DayPart, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Working late",
};

/** The part of the day an hour (0-23) falls in. */
export function dayPart(hour: number): DayPart {
  if (hour < 0 || hour > 23) throw new RangeError(\`hour \${String(hour)}\`);
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

/** The greeting for a moment. */
export function greetingAt(ms: number): Greeting {
  const part = dayPart(new Date(ms).getHours());
  return { part, text: TEXT[part] };
}

/** Joins a greeting and a name: "Good morning, Ana". */
export function withName(g: Greeting, name: string): string {
  return name ? \`\${g.text}, \${name}\` : g.text;
}

/** The first name of a full name, or the login when there is none. */
export function firstName(full: string, login: string): string {
  const [first = ""] = full.trim().split(/\\s+/);
  return first === "" ? login : first;
}

/** Greets the viewer, refreshed every minute. */
export function useGreeting(full: string, login: string): string {
  const now = useNow(60_000);
  return withName(greetingAt(now), firstName(full, login));
}

/** Short forms for narrow screens. */
export const SHORT: Record<DayPart, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Late night",
};

/** The short greeting for a moment. */
export function shortGreetingAt(ms: number): string {
  return SHORT[dayPart(new Date(ms).getHours())];
}
`,
    base: `/**
 * Greetings for the welcome screen: one per time of day, in the user's locale.
 */
import { useNow } from "./clock";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export interface Greeting {
  part: DayPart;
  text: string;
}

const TEXT: Record<DayPart, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Working late",
};

/** The part of the day an hour (0-23) falls in. */
export function dayPart(hour: number): DayPart {
  if (hour < 5) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "night";
}

/** The greeting for a moment. */
export function greetingAt(ms: number): Greeting {
  const part = dayPart(new Date(ms).getHours());
  return { part, text: TEXT[part] };
}

/** Joins a greeting and a name: "Good morning, Ana". */
export function withName(g: Greeting, name: string): string {
  return name ? \`\${g.text}, \${name}\` : g.text;
}

/** The first name of a full name, or the login when there is none. */
export function firstName(full: string, login: string): string {
  const first = full.trim().split(/\\s+/)[0];
  return first || login;
}

/** Greets the viewer, refreshed every minute. */
export function useGreeting(full: string, login: string): string {
  const now = useNow(60_000);
  return withName(greetingAt(now), firstName(full, login));
}

/** Short forms for narrow screens. */
export const SHORT: Record<DayPart, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Late",
};

/** The short greeting for a moment. */
export function shortGreetingAt(ms: number): string {
  return SHORT[dayPart(new Date(ms).getHours())];
}
`,
  },
  "docs/notes/welcome-greeting.md": { head: `# Welcome greeting

The welcome screen greets the viewer.

## Decisions

- One greeting per part of the day.
- First names only.
- No emoji.
`, base: null },
  "docs/notes/greeting.md": { head: null, base: `# Old name

The welcome screen greets the viewer.

## Decisions

- One greeting per part of the day.
- First names only.
- No emoji.
` },
  "gui/frontend/public/logo.png": { head: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), base: null },
};

/** A pull request's head as the diff reports it: its own, or one made up from its number (most fixtures have none). */
export function diffHead(number: number, head: string): string {
  return head || `d1ff${String(number)}`.padEnd(40, "0");
}

export class PrDiffWorld {
  /** "slug@sha" of every head a diff was reported for: GetPullRequestFile serves the new side there. */
  private readonly heads = new Set<string>();

  constructor(private readonly h: PrDiffHooks) {}

  diff(slug: string, number: number, refresh: boolean) {
    this.h.count(refresh ? "GetPullRequestDiff refresh" : "GetPullRequestDiff");
    const shas = this.h.shas(slug, number);
    if (!shas) throw new ConnectError(`Could not resolve to a PullRequest with the number of ${String(number)}.`, Code.NotFound);
    if (number === TOO_LARGE) throw new ConnectError(TOO_LARGE_MESSAGE, Code.FailedPrecondition);
    const head = diffHead(number, shas.head);
    this.heads.add(`${slug.toLowerCase()}@${head}`);
    return create(GetPullRequestDiffResponseSchema, { diff: PR_DIFF, headSha: head, baseSha: shas.base, truncated: false, fetchedAt: timestampFromDate(new Date()) });
  }

  file(slug: string, ref: string, path: string) {
    this.h.count(`GetPullRequestFile ${path}`);
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new ConnectError("ref must be a full commit SHA", Code.InvalidArgument);
    const f = FILES[path];
    const side = f ? (this.heads.has(`${slug.toLowerCase()}@${ref}`) ? f.head : f.base) : null;
    if (side === null) return create(GetPullRequestFileResponseSchema, { notFound: true });
    if (typeof side !== "string") return create(GetPullRequestFileResponseSchema, { contents: side, binary: true });
    return create(GetPullRequestFileResponseSchema, { contents: new TextEncoder().encode(side) });
  }
}
