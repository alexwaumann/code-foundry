/**
 * ThreadService.ListPrompts (docs/notes/prompt-history-1-daemon.md): the prompts the user
 * sent, newest first. Like the daemon it reads the threads' user_message items (the seeded
 * histories and whatever was sent since), and the four default-world threads named in
 * PROMPT_FIXTURES add a few more with distinct times so PROJECT and ALL have something to
 * span: Refactor sidebar tree (s-1), Fix resize race (s-3) and Investigate flaky e2e (s-4)
 * share repo-cf; Tidy zshrc (s-6) is repo-dot.
 *
 * The daemon's rules, simplified: wakes and attachment-only messages are left out; plugin
 * threads are never read; hidden child threads only in THREAD scope or as the PROJECT
 * anchor; archived threads count; a run of the same text in one thread is its newest; the
 * composer text's tags read as their chips (a file as its path, a thread as its name, a
 * pull request as #N, a skill as /name, image chips dropped).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { MessageOrigin } from "../src/gen/codefoundry/v1/thread_pb";
import { PromptScope, type ListPromptsRequest, type ListPromptsResponseSchema, type SentPromptSchema } from "../src/gen/codefoundry/v1/thread_prompts_pb";
import { CommandError } from "./errors";
import type { World } from "./world";

type ListPromptsResponseInit = MessageInitShape<typeof ListPromptsResponseSchema>;

/** A fixture prompt: minutes after its thread was created, the text as shown, and the composer text when it had tags. */
interface FixturePrompt {
  threadId: string;
  after: number;
  text: string;
  composerText?: string;
}

/** Fixture prompts across the default world's threads (minutes after each thread's creation; all distinct in time). */
export const PROMPT_FIXTURES: readonly FixturePrompt[] = [
  { threadId: "s-3", after: 5, text: "The sidebar flickers when the window resizes. Find the race." },
  { threadId: "s-4", after: 10, text: "Run the e2e suite 20 times and list the specs that fail." },
  { threadId: "s-3", after: 120, text: "Look at src/lib/useResize.ts again", composerText: "Look at [useResize.ts](cf-file://repo-cf/src/lib/useResize.ts) again" },
  { threadId: "s-4", after: 150, text: "Retry with --workers=1" },
  { threadId: "s-3", after: 190, text: "Add a test for the resize race and open a PR" },
  { threadId: "s-6", after: 25, text: "Tidy my zshrc: drop the unused aliases" },
  { threadId: "s-1", after: 2, text: "Refactor the sidebar tree into one virtualized list" },
  { threadId: "s-1", after: 30, text: "Keep the keyboard navigation from Fix resize race", composerText: "Keep the keyboard navigation from [Fix resize race](cf-thread://s-3)" },
];

/** One candidate prompt before scope, runs, query and limit. */
interface Candidate {
  threadId: string;
  itemId: string;
  text: string;
  composerText: string;
  sentAt: Date;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Composer tokens (src/lib/prompt.ts TOKEN): image | label, skill|file, slot, rest | thread label, id | pr number.
const TAG =
  /!\[[^[\]\n]*\]\(cf-attachment:\/\/[A-Za-z0-9_-]+\)|\[[^[\]\n]*\]\(cf-(skill|file):\/\/[A-Za-z0-9_.~-]+\/([^\s()]+)\)|\[([^[\]\n]*)\]\(cf-thread:\/\/([A-Za-z0-9_-]{1,64})\)|\[[^[\]\n]*\]\(cf-pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/([1-9][0-9]{0,9})\)/g;
const IMAGE = /!\[[^[\]\n]*\]\(cf-attachment:\/\/[A-Za-z0-9_-]+\) ?/g;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A prompt's display text and its composer text without image chips (the daemon's promptText, simplified). */
export function promptText(text: string, composerText: string, name: (id: string) => string | undefined): { text: string; composerText: string } {
  if (!composerText.trim()) return { text: text.replace(/@cf-file:\/\/[^/\s]+\/(\S+)/g, (_m, p: string) => `@${decode(p)}`).trim(), composerText: "" };
  const shown = composerText.replace(TAG, (m, kind?: string, rest?: string, label?: string, id?: string, pr?: string) => {
    if (m.startsWith("!")) return "";
    if (kind === "skill") return `/${decode(rest ?? "")}`;
    if (kind === "file") return decode(rest ?? "");
    if (id) return name(id) || label || id;
    if (pr) return `#${pr}`;
    return m;
  });
  return { text: shown.replace(/ {2,}/g, " ").trim(), composerText: composerText.replace(IMAGE, "").trim() };
}

/** ThreadService.ListPrompts over the world's threads. */
export function listPrompts(world: World, req: ListPromptsRequest): ListPromptsResponseInit {
  const threads = scopeThreads(world, req);
  const name = (id: string) => world.threads.get(id)?.name;
  const candidates: Candidate[] = [];
  for (const id of threads) {
    for (const it of world.logs.snapshotValue(id).items) {
      const p = it.payload;
      if (p?.case !== "userMessage" || it.parentToolUseId || (p.value.origin ?? MessageOrigin.USER) !== MessageOrigin.USER) continue;
      const shown = promptText(p.value.text ?? "", p.value.composerText ?? "", name);
      if (shown.text) candidates.push({ threadId: id, itemId: it.id ?? "", ...shown, sentAt: it.createdAt ? timestampDate(it.createdAt as Parameters<typeof timestampDate>[0]) : new Date(0) });
    }
  }
  for (const [i, f] of PROMPT_FIXTURES.entries()) {
    const t = world.threads.get(f.threadId);
    if (!t || !threads.has(t.id)) continue;
    candidates.push({ threadId: t.id, itemId: `${t.id}-prompt-${String(i)}`, text: f.text, composerText: f.composerText ?? "", sentAt: new Date(t.createdAt.getTime() + f.after * 60_000) });
  }
  candidates.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  const limit = Math.min(req.limit > 0 ? req.limit : DEFAULT_LIMIT, MAX_LIMIT);
  const query = req.query.trim().toLowerCase();
  const last = new Map<string, string>();
  const prompts: MessageInitShape<typeof SentPromptSchema>[] = [];
  for (const c of candidates) {
    if (last.get(c.threadId) === c.text) continue; // the same run: its newest is listed
    last.set(c.threadId, c.text);
    if (query && !c.text.toLowerCase().includes(query)) continue;
    if (prompts.length >= limit) break;
    prompts.push({ threadId: c.threadId, threadName: name(c.threadId) ?? "", itemId: c.itemId, text: c.text, composerText: c.composerText, sentAt: timestampFromDate(c.sentAt) });
  }
  return { prompts };
}

/** The ids of the threads req reads (the daemon's promptThreads). */
function scopeThreads(world: World, req: ListPromptsRequest): Set<string> {
  const listed = (id: string) => {
    const t = world.threads.get(id);
    return !!t && !t.owner && world.inSidebar(t);
  };
  const all = [...world.threads.keys()];
  switch (req.scope) {
    case PromptScope.THREAD: {
      if (!req.threadId) throw new CommandError("invalid", "a thread id is required");
      const t = world.thread(req.threadId);
      return new Set(t.owner ? [] : [t.id]);
    }
    case PromptScope.PROJECT: {
      if (req.threadId && req.projectIds.length > 0) throw new CommandError("invalid", "a thread id and project ids are exclusive");
      let set: string[];
      let anchor = "";
      if (req.threadId) {
        const t = world.thread(req.threadId);
        set = world.projectIdsOf(t);
        anchor = t.owner ? "" : t.id;
      } else {
        set = req.projectIds.map((ref) => {
          const p = world.projects.get(ref) ?? [...world.projects.values()].find((x) => x.name === ref);
          if (!p) throw new CommandError("invalid", `no project "${ref}"`);
          return p.id;
        });
      }
      const shares = (ids: string[]) => (ids.length === 0 || set.length === 0 ? ids.length === 0 && set.length === 0 : ids.some((id) => set.includes(id)));
      return new Set(all.filter((id) => id === anchor || (listed(id) && shares(world.projectIdsOf(world.thread(id))))));
    }
    case PromptScope.ALL:
      return new Set(all.filter(listed));
    default:
      throw new CommandError("invalid", "a scope is required: thread, project or all");
  }
}
