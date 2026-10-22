/**
 * The app memory in the mock daemon (docs/notes/memory-dir.md, memory-page.md): the
 * entries with provenance, MemoryService's snapshot, the EventService memory source and the
 * memory.* commands. Seeded with four entries: two by threads the mock has (s-1, s-3), one
 * from the user's terminal (no thread) and one by s-gone, a thread no longer in the list
 * (its recorded name shows, "(removed)").
 *
 * Controls (mock/server.ts): POST /__mock/memory?set=empty|seed|long (the entries, as a hand
 * edit; long adds an entry past 500 characters), ?drop=<file>&quiet=1 (a file removed by
 * hand without an event, so an open page is stale), POST /__mock/memory/add?text=…&thread=s-1 (a thread's `memory add`: the entry and
 * the daemon's "Remembered: …" toast with its Settings › Memory link). GET /__mock/memory:
 * { entries, calls }.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import type { MemoryEventSchema, MemorySnapshotSchema } from "../src/gen/codefoundry/v1/memory_pb";
import { UiIntent_Notify_Level } from "../src/gen/codefoundry/v1/ui_pb";
import { CommandError } from "./errors";
import type { SkillCommand } from "./skills";
import type { UiIntentInit } from "./world";

export type MemoryEventInit = MessageInitShape<typeof MemoryEventSchema>;
type SnapshotInit = MessageInitShape<typeof MemorySnapshotSchema>;

const MAX_ENTRIES = 40;
const MAX_BYTES = 4096;
const MAX_ENTRY_CHARS = 500;
const DIR = "/Users/dev/.code-foundry/memory";

interface Entry {
  file: string;
  text: string;
  created: Date | null;
  threadId: string;
  threadName: string;
}

const HOUR = 3_600_000;

function seed(now = Date.now()): Entry[] {
  return [
    { file: "never-open-the-side-panel-on-your-own.md", text: "Never open the side panel on your own; tell me and I will open it", created: new Date(now - 2 * HOUR), threadId: "s-1", threadName: "Refactor sidebar tree" },
    { file: "open-prs-as-drafts.md", text: "Open PRs as drafts", created: new Date(now - 26 * HOUR), threadId: "s-3", threadName: "Fix resize race" },
    { file: "explain-git-terms-the-first-time.md", text: "Explain git terms the first time you use them in a thread", created: new Date(now - 3 * 24 * HOUR), threadId: "", threadName: "" },
    { file: "keep-answers-short.md", text: "Keep answers short; one paragraph unless I ask for detail", created: new Date(now - 8 * 24 * HOUR), threadId: "s-gone", threadName: "Usage page polish" },
  ];
}

/** An entry past the 500-character cap, as an import or a hand edit leaves one (no frontmatter). */
function longEntry(): Entry {
  const text = `Always write very detailed commit messages that explain the reasoning ${"and the alternatives you considered ".repeat(18)}`.trim();
  return { file: "always-write-very-detailed-commit-messages-that.md", text, created: null, threadId: "", threadName: "" };
}

function slug(text: string, taken: (f: string) => boolean): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "entry";
  let file = `${base}.md`;
  for (let n = 2; taken(file); n++) file = `${base}-${String(n)}.md`;
  return file;
}

/** The daemon's Normalize, enough for the mock: trimmed, single spaces, no "- " or full stop. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/^- /, "").replace(/(?<!\.)\.$/, "");
}

export class MockMemory {
  private entries: Entry[] = seed();
  private version = 1;
  readonly calls: string[] = [];

  constructor(private readonly deps: { publish: (ev: MemoryEventInit) => void; emit: (i: UiIntentInit) => void }) {}

  reset(): void {
    this.entries = seed();
    this.calls.length = 0;
    this.changed();
  }

  snapshot(): SnapshotInit {
    // The daemon's markInjected: a too-long entry is left out on its own; of the rest, the
    // first within the entry and byte caps.
    let bytes = 0;
    let injected = 0;
    let full = "";
    const entries = this.entries.map((e, i) => {
      const line = `- ${e.text}\n`;
      let leftOut = "";
      if (Array.from(e.text).length > MAX_ENTRY_CHARS) leftOut = "too_long"; // characters, as the daemon counts them
      else if (full) leftOut = full;
      else if (injected === MAX_ENTRIES) leftOut = full = "entries";
      else if (bytes + line.length > MAX_BYTES) leftOut = full = "bytes";
      else {
        injected++;
        bytes += line.length;
      }
      return {
        index: i + 1,
        id: e.file.replace(/\.md$/, ""),
        text: e.text,
        file: e.file,
        ...(e.created ? { created: timestampFromDate(e.created) } : {}),
        threadId: e.threadId,
        threadName: e.threadName,
        injected: leftOut === "",
        leftOut,
      };
    });
    return { entries, injected, injectedBytes: bytes, maxEntries: MAX_ENTRIES, maxBytes: MAX_BYTES, maxEntryChars: MAX_ENTRY_CHARS, dir: DIR, error: "", version: BigInt(this.version) };
  }

  event(): MemoryEventInit {
    return { snapshot: this.snapshot() };
  }

  json(): { entries: Entry[]; calls: string[] } {
    return { entries: this.entries, calls: this.calls };
  }

  private changed(): void {
    this.version++;
    this.deps.publish(this.event());
  }

  /** Adds an entry; a thread's add (threadId set) shows the daemon's toast. Returns false for a duplicate. */
  add(raw: string, threadId = "", threadName = ""): boolean {
    const text = normalize(raw);
    if (!text) throw new CommandError("invalid", "a preference needs some text");
    if (text.length > MAX_ENTRY_CHARS) throw new CommandError("invalid", `an entry is at most ${String(MAX_ENTRY_CHARS)} characters and this one has ${String(text.length)}; say it shorter or split it in two`);
    if (this.entries.some((e) => e.text.toLowerCase() === text.toLowerCase())) return false;
    if (this.entries.length >= MAX_ENTRIES) throw new CommandError("invalid", "memory is full");
    const last = this.entries.at(-1)?.created?.getTime() ?? 0;
    this.entries.push({ file: slug(text, (f) => this.entries.some((e) => e.file === f)), text, created: new Date(Math.max(Date.now(), last + 1)), threadId, threadName });
    this.changed();
    if (threadId) this.notify(`Remembered: ${text}`, threadName || threadId);
    return true;
  }

  private notify(title: string, by: string): void {
    this.deps.emit({
      intent: { case: "notify", value: { level: UiIntent_Notify_Level.INFO, title: title.slice(0, 120), body: `By thread "${by}".`, link: "settings:memory", linkLabel: "Show in Settings" } },
    });
  }

  /** memory remove's lookup: digits in range are an index, else the text, else the one entry containing it. */
  private find(ref: string): number {
    const r = ref.trim();
    if (/^\d+$/.test(r)) {
      const n = Number(r);
      if (n >= 1 && n <= this.entries.length) return n - 1;
    }
    const want = normalize(r).toLowerCase();
    const exact = this.entries.findIndex((e) => e.text.toLowerCase() === want);
    if (exact >= 0) return exact;
    const hits = this.entries.flatMap((e, i) => (e.text.toLowerCase().includes(want) ? [i] : []));
    if (hits.length === 1 && hits[0] !== undefined) return hits[0];
    if (hits.length > 1) throw new CommandError("invalid", `${String(hits.length)} preferences contain "${r}"; give its number from memory show`);
    if (/^\d+$/.test(r)) throw new CommandError("invalid", `there is no preference ${r}; memory show numbers them 1 to ${String(this.entries.length)}`);
    throw new CommandError("notfound", `no preference matches "${r}"`);
  }

  /**
   * POST /__mock/memory?set=empty|seed|long (long: the seed plus an imported 700-character
   * entry, which threads do not get), or ?drop=<file>&quiet=1: the file removed by hand and
   * no event published, so an open page's list is stale (as before the directory watch).
   */
  control(q: URLSearchParams): { entries: number } {
    const set = q.get("set");
    const drop = q.get("drop");
    if (drop) {
      this.entries = this.entries.filter((e) => e.file !== drop);
      if (q.get("quiet") === "1") return { entries: this.entries.length };
    } else if (set === "empty") this.entries = [];
    else if (set === "seed") this.entries = seed();
    else if (set === "long") this.entries = [...seed(), longEntry()];
    else throw new CommandError("invalid", "set must be empty, seed or long, or drop a file");
    this.changed();
    return { entries: this.entries.length };
  }

  commands(): SkillCommand[] {
    const always = () => true;
    const cmd = (name: string, title: string, description: string, args: SkillCommand["cmd"]["args"], confirm?: SkillCommand["cmd"]["confirm"]): SkillCommand["cmd"] => ({
      name,
      title,
      category: "Settings",
      description,
      keybindings: [],
      args,
      ...(confirm ? { confirm } : {}),
    });
    const record = (name: string, a: Record<string, string>) => {
      this.calls.push(`${name} ${JSON.stringify(a)}`);
    };
    return [
      {
        cmd: cmd("memory.show", "Memory: Show Preferences", "List the user's standing preferences, numbered.", []),
        when: always,
        run: (_c: UiContext | undefined, a) => {
          record("memory.show", a);
          return this.entries.length === 0 ? 'No preferences remembered. Add one with: code-foundry memory add "<preference>"' : this.entries.map((e, i) => `${String(i + 1)}. ${e.text}`).join("\n");
        },
      },
      {
        cmd: cmd("memory.add", "Memory: Remember a Preference", "Remember a standing preference for every thread in every project.", [
          { name: "text", type: ArgType.STRING, required: true, description: "The preference, one line (several words need no quotes)" },
        ]),
        when: always,
        run: (_c, a) => {
          record("memory.add", a);
          const text = normalize(a.text ?? "");
          if (!this.add(text)) return `Already remembered: "${text}" (nothing changed).`;
          return `Remembered: "${text}". New threads will follow it; threads already open get it on their next message after a restart.`;
        },
      },
      {
        cmd: cmd("memory.remove", "Memory: Forget a Preference", "Forget one remembered preference: by its number in `memory show`, its text, its id, or text found in it alone.", [
          { name: "entry", type: ArgType.STRING, required: false, description: "The entry's number in memory show, its text, its id, or text that only that entry contains" },
          { name: "id", type: ArgType.STRING, required: false, description: "The entry's id (memory show --json): its file name without .md. Instead of entry" },
        ]),
        when: always,
        run: (_c, a) => {
          record("memory.remove", a);
          const id = a.id ?? "";
          let at: number;
          if (id) {
            at = this.entries.findIndex((e) => e.file.replace(/\.md$/, "").toLowerCase() === id.toLowerCase());
            if (at < 0) throw new CommandError("notfound", `there is no entry ${id} now; it was removed or its file renamed`);
          } else at = this.find(a.entry ?? "");
          const [gone] = this.entries.splice(at, 1);
          this.changed();
          return `Forgot: "${gone?.text ?? ""}".`;
        },
      },
      {
        cmd: {
          ...cmd("memory.clear", "Memory: Forget All Preferences", "Forget every remembered preference. New threads get none.", [], () => "Forget every remembered preference? New threads get none."),
          confirmLabel: "Forget all",
        },
        when: always,
        run: (_c, a) => {
          record("memory.clear", a);
          const n = this.entries.length;
          if (n === 0) return "No preferences to forget.";
          this.entries = [];
          this.changed();
          return `Forgot ${String(n)} preference${n === 1 ? "" : "s"}.`;
        },
      },
    ];
  }
}
