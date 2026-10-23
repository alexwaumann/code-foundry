/**
 * The user's own themes in the mock daemon (docs/notes/user-themes.md): the themes
 * directory as ThemeService's snapshot, the EventService theme source and the theme.*
 * verbs that write it (show, save, duplicate, delete). Seeded with three: Ocean Dusk
 * (dark, from Catppuccin Mocha, written by thread s-1), Mocha, warmer (dark, from
 * Catppuccin Mocha, three slots pinned) and Latte, softer (light, from Catppuccin Latte,
 * by s-3), plus a file that does not load.
 *
 * Controls (mock/server.ts): POST /__mock/themes?set=empty|seed (the directory, as a hand
 * edit); POST /__mock/themes/card?thread=s-1&theme=ocean-dusk[&apply=true] (theme save run
 * from that thread: the card and, when applied, the toast; docs/notes/theme-model-flow.md);
 * POST /__mock/themes/edit?theme=ocean-dusk&canvas=%23330000 (a save from outside the window);
 * GET /__mock/themes: { themes, calls, reports }.
 *
 * The GUI's contrast reports (docs/notes/theme-followups.md): UiService.PublishThemeReport
 * keeps the last report per theme, keyed by the file's version (a hash of its JSON, as the
 * daemon's theme.File.Version); theme save waits up to 1.5 s for the report on the file it
 * wrote and prints it, and theme check prints the latest.
 */
import { createHash } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import type { ThemeEventSchema, ThemeSnapshotSchema, UserThemeSchema } from "../src/gen/codefoundry/v1/theme_pb";
import { UiIntent_Notify_Level, type ThemeReport, type UiIntentSchema } from "../src/gen/codefoundry/v1/ui_pb";
import { themeById, themes as curated, type ThemeBase, type ThemeFile, type ThemeScheme } from "../src/themes";
import { parseThemeFile } from "../src/themes/slots";
import { CommandError } from "./errors";
import type { SkillCommand } from "./skills";

export type ThemeEventInit = MessageInitShape<typeof ThemeEventSchema>;
type SnapshotInit = MessageInitShape<typeof ThemeSnapshotSchema>;
type UserThemeInit = MessageInitShape<typeof UserThemeSchema>;
type IntentInit = MessageInitShape<typeof UiIntentSchema>;

const DIR = "/Users/dev/.code-foundry/themes";

export interface MockUserTheme extends ThemeFile {
  from: string;
  createdBy: string;
}

function baseOf(id: string, edit: Partial<Omit<ThemeBase, "terminal">>): ThemeBase {
  const t = themeById.get(id);
  if (!t) throw new Error(`no curated theme ${id}`);
  return { ...t.base, ...edit, terminal: { ...t.base.terminal, ansi: [...t.base.terminal.ansi] } };
}

function seed(): MockUserTheme[] {
  return [
    {
      id: "ocean-dusk",
      name: "Ocean Dusk",
      scheme: "dark",
      source: "",
      from: "catppuccin-mocha",
      createdBy: "s-1",
      base: baseOf("catppuccin-mocha", {
        canvas: "#0b141c", surface: "#16232f", text: "#d7e3ea", accent: "#5fb3b3",
        success: "#8fc79a", warning: "#e8c07d", error: "#ec7f8a", info: "#7fb4e0", highlight: "#c3a6e8",
      }),
      overrides: { "--cf-sidebar-row-selected": "#1e2e3c" },
    },
    {
      id: "mocha-warmer",
      name: "Mocha, warmer",
      scheme: "dark",
      source: "",
      from: "catppuccin-mocha",
      createdBy: "",
      base: baseOf("catppuccin-mocha", { canvas: "#1a1614", surface: "#221d1b", text: "#e8dccb", accent: "#d9a066" }),
      overrides: { "--cf-accent-foreground": "#1a1614", "--cf-sidebar-row-selected": "#2c2522", "--syn-kw": "#e0a370" },
    },
    {
      id: "latte-softer",
      name: "Latte, softer",
      scheme: "light",
      source: "",
      from: "catppuccin-latte",
      createdBy: "s-3",
      base: baseOf("catppuccin-latte", { canvas: "#e9e4dc", surface: "#f6f1ea", accent: "#8c6bb1" }),
    },
  ];
}

const SEED_ISSUES = [{ file: "draft.json", message: 'base.accent: "#5fb3" is not #rrggbb' }];

/** The daemon's theme.ParseFile: the GUI's parseThemeFile in user mode, which it mirrors. */
function parse(text: string): MockUserTheme {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CommandError("invalid", "the theme does not validate: not JSON");
  }
  try {
    const { from = "", createdBy = "", ...file } = parseThemeFile(v, { user: true });
    return { ...file, from, createdBy };
  } catch (err) {
    throw new CommandError("invalid", `the theme does not validate: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The file as the daemon writes it (theme.File's JSON names). */
function fileJson(t: MockUserTheme): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    scheme: t.scheme,
    ...(t.pair ? { pair: t.pair } : {}),
    ...(t.from ? { from: t.from } : {}),
    ...(t.createdBy ? { created_by: t.createdBy } : {}),
    ...(t.source ? { source: t.source } : {}),
    base: t.base,
    ...(t.overrides && Object.keys(t.overrides).length ? { overrides: t.overrides } : {}),
  };
}

/** The file's version: a hash of what it holds, as the daemon's theme.File.Version. */
export function versionOf(t: MockUserTheme): string {
  return createHash("sha256").update(JSON.stringify(fileJson(t))).digest("hex").slice(0, 32);
}

/** What a theme paints with: a save that changes none of it repaints nothing. */
const paint = (t: MockUserTheme) => JSON.stringify({ scheme: t.scheme, base: t.base, overrides: t.overrides ?? {} });

/** A report the GUI published, as the daemon keeps it. */
interface MockReport {
  version: string;
  issues: { slot: string; against: string; label: string; ratio: number; required: number }[];
  stale: { slot: string; pinned: string; basis: string; derived: string }[];
}

const ratioText = (r: number) => (r < 2 ? `${(Math.floor(r * 100) / 100).toFixed(2)}:1` : `${(Math.floor(r * 10) / 10).toFixed(1)}:1`);
const short = (s: string) => s.replaceAll("--cf-", "");
const issueText = (i: MockReport["issues"][number]) => `${short(i.label || `${i.slot} on ${i.against}`)} ${ratioText(i.ratio)} (needs ${String(i.required)})`;

/** The report in words, as the daemon's ThemeCheck.lines: inline for save, one per line for check. */
function reportLines(id: string, r: MockReport | undefined, full: boolean): string[] {
  if (!r) return [`contrast: not checked yet (the app has not reported on this version yet; theme check ${id} in a moment)`];
  const n = r.issues.length;
  const plural = `${String(n)} ${n === 1 ? "issue" : "issues"}`;
  const out =
    n === 0
      ? ["contrast: ok"]
      : full
        ? [`contrast: ${plural}`, ...r.issues.map((i) => `  ${issueText(i)}`)]
        : [`contrast: ${plural} — ${[...r.issues.slice(0, 6).map(issueText), ...(n > 6 ? [`and ${String(n - 6)} more (theme check ${id} lists every one)`] : [])].join(", ")}`];
  const stale = r.stale.map((p) => `${short(p.slot)} (pinned ${p.pinned} when its rule gave ${p.basis}; it gives ${p.derived} now)`);
  return [...out, stale.length ? `stale pins: ${String(stale.length)} — ${stale.join(", ")}` : "stale pins: 0"];
}

/** A user theme as ThemeService's (and a theme card's) UserTheme. */
function protoOf(t: MockUserTheme, path: string): UserThemeInit {
  return {
    id: t.id,
    name: t.name,
    scheme: t.scheme,
    pair: t.pair ?? "",
    from: t.from,
    createdBy: t.createdBy,
    source: t.source,
    base: { ...t.base, link: t.base.link ?? "", terminal: { foreground: t.base.terminal.foreground, cursor: t.base.terminal.cursor ?? "", cursorText: t.base.terminal.cursorText ?? "", selection: t.base.terminal.selection ?? "", ansi: [...t.base.terminal.ansi] } },
    overrides: { ...(t.overrides ?? {}) },
    path,
    version: versionOf(t),
  };
}

export class MockThemes {
  private user: MockUserTheme[] = seed();
  private issues = [...SEED_ISSUES];
  private version = 1;
  readonly calls: string[] = [];
  /** The GUI's contrast reports, by theme id (UiService.PublishThemeReport). */
  private reports = new Map<string, MockReport>();
  private reportWaiters = new Set<() => void>();
  /** The versions each save replaced, newest first, at most 10 per theme (the daemon's .history). */
  private history = new Map<string, MockUserTheme[]>();

  constructor(
    private readonly deps: {
      publish: (ev: ThemeEventInit) => void;
      /** The settings the slots are, read and written (mock/settings.ts). */
      slot: (scheme: ThemeScheme) => string;
      setSlot: (scheme: ThemeScheme, id: string) => void;
      /** appearance.theme (theme.set-scheme). */
      setScheme?: (scheme: string) => void;
      /** ThreadService.ShowTheme: appends the card. */
      card?: (threadId: string, card: { theme: UserThemeInit; applied: boolean; previous: string; previousVersion: string; previousGone: boolean }) => void;
      /** Shows a toast in the window (UiIntent). */
      emit?: (intent: IntentInit) => void;
    },
  ) {}

  reset(): void {
    this.user = seed();
    this.issues = [...SEED_ISSUES];
    this.calls.length = 0;
    this.changed();
  }

  /** The user's themes of a scheme, by name, as the settings' theme selects list them. */
  choices(scheme: ThemeScheme): { id: string; name: string }[] {
    return this.sorted()
      .filter((t) => t.scheme === scheme)
      .map((t) => ({ id: t.id, name: t.name }));
  }

  /** The user's themes by name, then id, as the daemon lists them. */
  private sorted(): MockUserTheme[] {
    return [...this.user].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  }

  snapshot(): SnapshotInit {
    return {
      curated: curated.map((t) => ({ id: t.id, name: t.name, scheme: t.scheme, pair: t.pair ?? "" })),
      user: this.sorted().map((t) => ({ ...protoOf(t, `${DIR}/${t.id}.json`), history: (this.history.get(t.id) ?? []).map(versionOf) })),
      issues: this.issues,
      dir: DIR,
      version: BigInt(this.version),
    };
  }

  event(): ThemeEventInit {
    return { snapshot: this.snapshot() };
  }

  json(): { themes: MockUserTheme[]; calls: string[]; reports: Record<string, MockReport> } {
    return { themes: this.user, calls: this.calls, reports: Object.fromEntries(this.reports) };
  }

  /** UiService.PublishThemeReport: keeps each report, waking a save that waits for it. */
  publishReports(reports: readonly ThemeReport[]): void {
    for (const r of reports) {
      if (!/^[0-9a-f]{1,64}$/.test(r.version)) throw new CommandError("invalid", `bad theme report: theme "${r.id}": version "${r.version}" is not a file version (lowercase hex)`);
    }
    for (const r of reports) {
      this.reports.set(r.id, {
        version: r.version,
        issues: r.issues.map((i) => ({ slot: i.slot, against: i.against, label: i.label, ratio: i.ratio, required: i.required })),
        stale: r.stale.map((p) => ({ slot: p.slot, pinned: p.pinned, basis: p.basis, derived: p.derived })),
      });
    }
    for (const w of [...this.reportWaiters]) w();
  }

  /** The report on this version of t, waiting up to ms for it. */
  private async reportOn(t: MockUserTheme, ms = 1500): Promise<MockReport | undefined> {
    const version = versionOf(t);
    const now = () => {
      const r = this.reports.get(t.id);
      return r?.version === version ? r : undefined;
    };
    const there = now();
    if (there) return there;
    return new Promise((resolve) => {
      const done = (r: MockReport | undefined) => {
        clearTimeout(timer);
        this.reportWaiters.delete(check);
        resolve(r);
      };
      const check = () => {
        const r = now();
        if (r) done(r);
      };
      const timer = setTimeout(() => {
        done(undefined);
      }, ms);
      this.reportWaiters.add(check);
    });
  }

  private changed(): void {
    this.version++;
    this.deps.publish(this.event());
  }

  private find(id: string): { file: MockUserTheme | ThemeFile; user: boolean } {
    const u = this.user.find((t) => t.id === id);
    if (u) return { file: u, user: true };
    const c = themeById.get(id);
    if (c && !c.user) return { file: c, user: false };
    throw new CommandError("notfound", `no such theme "${id}"`);
  }

  private save(t: MockUserTheme): { replaced: boolean; previousVersion: string } {
    if (curated.some((c) => c.id === t.id)) throw new CommandError("invalid", `"${t.id}" is a curated theme's id; save under another id (theme duplicate ${t.id} makes a copy)`);
    const was = this.user.find((u) => u.id === t.id);
    let previousVersion = "";
    if (was && versionOf(was) !== versionOf(t)) {
      // The replaced version is kept for a card's Undo (theme.restore).
      const kept = (this.history.get(t.id) ?? []).filter((h) => versionOf(h) !== versionOf(was));
      this.history.set(t.id, [was, ...kept].slice(0, 10));
      previousVersion = versionOf(was);
    }
    this.user = [...this.user.filter((u) => u.id !== t.id), t];
    this.changed();
    return { replaced: !!was, previousVersion };
  }

  private lines(t: MockUserTheme, replaced: boolean, contrast: string[]): string[] {
    const pinned = Object.keys(t.overrides ?? {}).length;
    const from = t.from ? `from: ${themeById.get(t.from)?.name ?? t.from} (${t.from})` : "from: nothing (made from scratch)";
    return [`${replaced ? "replaced" : "saved"} ${t.name} (${t.id}), a ${t.scheme} theme`, from, `pinned: ${String(pinned)} ${pinned === 1 ? "slot" : "slots"}`, ...contrast, `written to: ${DIR}/${t.id}.json`];
  }

  /** The save's contrast lines: from the app's editor none is waited for, as the daemon. */
  private async contrastLines(c: UiContext | undefined, t: MockUserTheme): Promise<string[]> {
    if (c?.activeView) return ["contrast: shown in the Themes page's editor"];
    return reportLines(t.id, await this.reportOn(t), false);
  }

  /**
   * What theme save does after the write when it runs from a thread, like the daemon's
   * showThemeCard: the card (applied when --apply, or when the slot already had it; its
   * Undo what the slot showed just before: another theme, or the version this save replaced,
   * docs/notes/theme-fuzz-daemon.md) and, when the save changed what the slot shows
   * (another theme, or new colours: `was` is the file before), the "<name> applied to
   * <scheme>" toast with Undo and Edit, which a window on the Themes page skips.
   */
  private fromThread(threadId: string, t: MockUserTheme, apply: boolean, before: string, was: MockUserTheme | undefined, previousVersion: string): void {
    const applied = apply || before === t.id;
    const repaint = before !== t.id || !was || paint(was) !== paint(t);
    let previous = "";
    let version = "";
    if (applied && before && before !== t.id) previous = before;
    else if (applied && before === t.id && was && paint(was) !== paint(t)) [previous, version] = [t.id, previousVersion];
    const gone = previous !== "" && previous === t.id && !version;
    this.deps.card?.(threadId, { theme: protoOf(t, ""), applied, previous, previousVersion: version, previousGone: gone });
    if (!applied || !repaint) return;
    const edit = { link: `theme-edit:${t.id}`, label: "Edit" };
    const undo = previous && !gone ? { link: `theme-undo:${t.scheme}:${t.id}:${previous}${version ? `:${version}` : ""}`, label: "Undo" } : null;
    this.deps.emit?.({
      intent: {
        case: "notify",
        value: {
          level: UiIntent_Notify_Level.INFO,
          title: `${t.name} applied to ${t.scheme}`,
          unlessShowing: "themes",
          ...(undo ? { link: undo.link, linkLabel: undo.label, secondaryLink: edit.link, secondaryLinkLabel: edit.label } : { link: edit.link, linkLabel: edit.label }),
        },
      },
    });
  }

  /**
   * POST /__mock/themes/card?thread=&theme=[&apply=true]: theme save of one of the user's
   * themes run from that thread (the file unchanged), as the model's save would be.
   */
  card(q: URLSearchParams): { ok: true } {
    const threadId = q.get("thread") ?? "";
    const u = this.user.find((t) => t.id === q.get("theme"));
    if (!threadId || !u) throw new Error("want thread=<id>&theme=<one of the user's themes>");
    const before = this.deps.slot(u.scheme);
    const apply = q.get("apply") === "true";
    if (apply) this.deps.setSlot(u.scheme, u.id);
    // The file unchanged: a repaint only when the slot moves onto it.
    this.fromThread(threadId, u, apply, before, u, "");
    return { ok: true };
  }

  /**
   * POST /__mock/themes/recolour?thread=&theme=&accent=#rrggbb: theme save from that
   * thread of the theme with a new accent, as a model's refinement of the theme in use.
   */
  recolour(q: URLSearchParams): { ok: true } {
    const threadId = q.get("thread") ?? "";
    const u = this.user.find((t) => t.id === q.get("theme"));
    const accent = q.get("accent") ?? "";
    if (!threadId || !u || !/^#[0-9a-f]{6}$/.test(accent)) throw new Error("want thread=<id>&theme=<one of the user's themes>&accent=#rrggbb");
    const before = this.deps.slot(u.scheme);
    const t: MockUserTheme = { ...u, base: { ...u.base, accent } };
    const { previousVersion } = this.save(t);
    this.fromThread(threadId, t, false, before, u, previousVersion);
    return { ok: true };
  }

  /** One of the user's themes as a theme card's UserTheme (no path), or undefined. */
  cardOf(id: string): UserThemeInit | undefined {
    const t = this.userTheme(id);
    return t && protoOf(t, "");
  }

  /** One of the user's themes, or undefined. */
  userTheme(id: string): MockUserTheme | undefined {
    return this.user.find((t) => t.id === id);
  }

  /** Whether id is one of the user's themes (theme.edit's check). */
  isUser(id: string): boolean {
    return this.user.some((u) => u.id === id);
  }

  private savedJson(t: MockUserTheme, replaced: boolean, applied = ""): string {
    return JSON.stringify({ id: t.id, name: t.name, scheme: t.scheme, from: t.from, created_by: t.createdBy, pinned: Object.keys(t.overrides ?? {}).length, path: `${DIR}/${t.id}.json`, replaced, ...(applied ? { applied } : {}) });
  }

  commands(): SkillCommand[] {
    const always = () => true;
    const thread = (c: UiContext | undefined) => (c?.activeView ? "" : (c?.activeThreadId ?? ""));
    const cmd = (name: string, title: string, description: string, args: SkillCommand["cmd"]["args"]): SkillCommand["cmd"] => ({ name, title, category: "Settings", description, keybindings: [], args });
    const allIds = () => [...this.sorted().map((t) => t.id), ...curated.map((t) => t.id)];
    return [
      {
        cmd: cmd("theme.show", "Show Theme File", "Print a theme's file as JSON (a curated theme or one of yours): the format theme save reads.", [
          { name: "theme", type: ArgType.ENUM, required: true, description: "A theme id (theme list prints them)", enumValues: allIds() },
        ]),
        when: always,
        run: (_c, a) => {
          this.calls.push(`theme.show ${a.theme ?? ""}`);
          const { file, user } = this.find(a.theme ?? "");
          const json = user ? fileJson(file as MockUserTheme) : { id: file.id, name: file.name, scheme: file.scheme, ...(file.pair ? { pair: file.pair } : {}), source: file.source, base: file.base, ...(file.overrides ? { overrides: file.overrides } : {}) };
          return Promise.resolve({ message: JSON.stringify(json, null, 2), resultJson: JSON.stringify(json) });
        },
      },
      {
        cmd: cmd("theme.save", "Save Theme File", "Validate a theme file and save it as one of your themes. --apply also makes it the dark or light theme, per its scheme.", [
          { name: "file", type: ArgType.PATH, required: false, description: "The theme file (JSON) to read" },
          { name: "data", type: ArgType.STRING, required: false, description: "The theme file itself, its JSON (-: stdin, @file: a file); instead of --file" },
          { name: "apply", type: ArgType.BOOL, required: false, description: "Also set it as the dark or light theme, per its scheme" },
          { name: "replace", type: ArgType.BOOL, required: false, description: "From a thread: replace a theme with this id that the thread did not make" },
        ]),
        when: always,
        run: async (c, a) => {
          this.calls.push(`theme.save ${a.data ? "data" : (a.file ?? "")}`);
          if (!a.data) throw new CommandError("invalid", "the mock reads --data only");
          const t = parse(a.data);
          const by = thread(c);
          const before = this.deps.slot(t.scheme);
          const was = this.user.find((u) => u.id === t.id);
          if (was && by && was.createdBy !== by && a.replace !== "true") {
            throw new CommandError("invalid", `${was.name} (${was.id}) is a theme this thread did not make; save under another id, or pass --replace once the user asked to change that theme`);
          }
          if (was && was.scheme !== t.scheme && this.deps.slot(was.scheme) === was.id) {
            throw new CommandError("invalid", `${was.id} is your ${was.scheme} theme; a ${t.scheme} theme needs another id`);
          }
          if (by) t.createdBy = was ? was.createdBy : by;
          const { replaced, previousVersion } = this.save(t);
          let applied = "";
          const after: string[] = [];
          if (a.apply === "true") {
            this.deps.setSlot(t.scheme, t.id);
            applied = `appearance.theme_${t.scheme}`;
            after.push(`applied: ${t.scheme} theme = ${t.name} (${t.id})`);
          }
          if (by) this.fromThread(by, t, a.apply === "true", before, was, previousVersion);
          const lines = [...this.lines(t, replaced, await this.contrastLines(c, t)), ...after];
          return { message: lines.join("\n"), resultJson: this.savedJson(t, replaced, applied) };
        },
      },
      {
        cmd: cmd("theme.duplicate", "Duplicate Theme", "Copy a theme (curated or yours) into your themes under a new id (<id>-copy, then -2, ...), recording the theme it came from.", [
          { name: "theme", type: ArgType.ENUM, required: true, description: "The theme to copy (theme list prints the ids)", enumValues: allIds() },
          { name: "name", type: ArgType.STRING, required: false, description: 'The copy\'s name (default: "<name> copy")' },
        ]),
        when: always,
        run: async (c, a) => {
          this.calls.push(`theme.duplicate ${a.theme ?? ""}`);
          const { file } = this.find(a.theme ?? "");
          const taken = (id: string) => this.user.some((u) => u.id === id) || curated.some((t) => t.id === id);
          const baseId = `${file.id}-copy`;
          let id = baseId;
          let n = 1;
          while (taken(id)) id = `${baseId}-${String(++n)}`;
          const t: MockUserTheme = {
            id,
            name: a.name?.trim() || `${file.name} copy${n > 1 ? ` ${String(n)}` : ""}`,
            scheme: file.scheme,
            // No pair: the original's pair is the original's.
            source: file.source,
            base: { ...file.base, terminal: { ...file.base.terminal, ansi: [...file.base.terminal.ansi] } },
            ...(file.overrides ? { overrides: { ...file.overrides } } : {}),
            from: file.id,
            createdBy: thread(c),
          };
          this.save(t);
          return { message: this.lines(t, false, await this.contrastLines(c, t)).join("\n"), resultJson: this.savedJson(t, false) };
        },
      },
      {
        cmd: cmd("theme.restore", "Restore Theme Colours", "Put back an earlier version of one of your themes: each save keeps the version it replaces (the last 10).", [
          { name: "theme", type: ArgType.ENUM, required: true, description: "One of your themes' ids", enumValues: this.sorted().map((t) => t.id) },
          { name: "version", type: ArgType.STRING, required: true, description: "The version to put back (a theme card's previous_version)" },
        ]),
        when: always,
        run: async (c, a) => {
          this.calls.push(`theme.restore ${a.theme ?? ""} ${a.version ?? ""}`);
          const kept = (this.history.get(a.theme ?? "") ?? []).find((h) => versionOf(h) === a.version);
          if (!kept) throw new CommandError("notfound", `the version of "${a.theme ?? ""}" from before is no longer kept (only the last 10 are)`);
          const { replaced } = this.save({ ...kept });
          const lines = this.lines(kept, replaced, await this.contrastLines(c, kept));
          lines[0] = `restored ${kept.name} (${kept.id}) to an earlier version`;
          return { message: lines.join("\n"), resultJson: this.savedJson(kept, replaced) };
        },
      },
      {
        cmd: cmd("theme.set-scheme", "Set Color Scheme", "Choose whether the app is dark, light, or follows the Mac (system): the appearance.theme setting.", [
          { name: "scheme", type: ArgType.ENUM, required: true, description: "system (follow the Mac), dark or light", enumValues: ["system", "dark", "light"] },
        ]),
        when: always,
        run: (_c, a) => {
          this.calls.push(`theme.set-scheme ${a.scheme ?? ""}`);
          this.deps.setScheme?.(a.scheme ?? "system");
          return Promise.resolve({ message: `scheme = ${a.scheme ?? ""} (appearance.theme)`, resultJson: JSON.stringify({ key: "appearance.theme", scheme: a.scheme }) });
        },
      },
      {
        cmd: cmd("theme.check", "Check Theme Contrast", "Print the app's contrast check of one of your themes: each pair of colours that falls short and each pin whose rule the base has moved.", [
          { name: "theme", type: ArgType.ENUM, required: true, description: "One of your themes' ids (theme list marks them)", enumValues: this.sorted().map((t) => t.id) },
        ]),
        when: always,
        run: async (_c, a) => {
          this.calls.push(`theme.check ${a.theme ?? ""}`);
          const t = this.user.find((u) => u.id === a.theme);
          if (!t) throw new CommandError("invalid", `argument "theme": "${a.theme ?? ""}" is not one of your themes`);
          const r = await this.reportOn(t);
          const message = [`${t.name} (${t.id}), a ${t.scheme} theme`, ...reportLines(t.id, r, true)].join("\n");
          return { message, resultJson: JSON.stringify({ id: t.id, version: versionOf(t), checked: !!r, ...(r ? { issues: r.issues, stale: r.stale } : { reason: "the app has not reported on this version yet" }) }) };
        },
      },
      {
        cmd: {
          ...cmd("theme.delete", "Delete Theme", "Delete one of your themes (its file in the themes directory). A slot that used it shows the theme it was copied from, else the default. --file removes a file that did not load.", [
            { name: "theme", type: ArgType.STRING, required: false, description: "One of your themes' ids (theme list marks them)" },
            { name: "file", type: ArgType.STRING, required: false, description: "A file in the themes directory that did not load, by its name" },
          ]),
          confirm: (_c, a) => {
            const issue = this.issueOf(a);
            if (issue) return `Delete the file ${issue.file} from the themes directory? It did not load: ${issue.message}.`;
            const t = this.user.find((u) => u.id === a.theme);
            if (!t) return `Delete the theme ${a.theme ?? ""}? Its file in the themes directory is removed.`;
            let msg = `Delete the theme ${t.name}? Its file in the themes directory is removed.`;
            if (this.deps.slot(t.scheme) === t.id) msg += ` It is your ${t.scheme} theme; the ${t.scheme} theme becomes ${this.fallbackOf(t).name}.`;
            return msg;
          },
          confirmLabel: "Delete",
        },
        when: always,
        run: (_c, a) => {
          this.calls.push(`theme.delete ${a.theme ?? a.file ?? ""}`);
          const issue = this.issueOf(a);
          if (issue) {
            this.issues = this.issues.filter((i) => i.file !== issue.file);
            this.changed();
            return Promise.resolve({ message: `deleted the file ${issue.file} (it did not load: ${issue.message})`, resultJson: JSON.stringify(issue) });
          }
          if (a.file) throw new CommandError("invalid", `no file "${a.file}" among those that did not load (theme list names them)`);
          const id = a.theme ?? "";
          if (curated.some((t) => t.id === id)) throw new CommandError("invalid", `"${id}" is a curated theme; only your own themes can be deleted`);
          const t = this.user.find((u) => u.id === id);
          if (!t) throw new CommandError("notfound", `no such theme "${id}" among your themes`);
          const lines = [`deleted ${t.name} (${t.id})`];
          const slots: Record<string, string> = {};
          if (this.deps.slot(t.scheme) === t.id) {
            const next = this.fallbackOf(t);
            this.deps.setSlot(t.scheme, next.id);
            slots[`appearance.theme_${t.scheme}`] = next.id;
            lines.push(`now ${t.scheme} theme = ${next.name} (${next.id})`);
          }
          this.user = this.user.filter((u) => u.id !== id);
          this.history.delete(id);
          this.changed();
          return Promise.resolve({ message: lines.join("\n"), resultJson: JSON.stringify({ id: t.id, name: t.name, scheme: t.scheme, ...(Object.keys(slots).length ? { slots } : {}) }) });
        },
      },
    ];
  }

  /** The file that did not load a delete names: --file, or the id of its name. */
  private issueOf(a: Record<string, string | undefined>): { file: string; message: string } | undefined {
    if (a.file) return this.issues.find((i) => i.file === a.file);
    if (a.theme && !this.user.some((u) => u.id === a.theme)) return this.issues.find((i) => i.file.toLowerCase() === `${a.theme ?? ""}.json`);
    return undefined;
  }

  /** What a slot naming t shows once t is deleted: its from when that is a theme of its scheme, else the default. */
  private fallbackOf(t: MockUserTheme): { id: string; name: string } {
    const from = this.user.find((u) => u.id === t.from && u.id !== t.id) ?? curated.find((c) => c.id === t.from);
    if (from && from.scheme === t.scheme) return { id: from.id, name: from.name };
    const def = curated.find((c) => c.scheme === t.scheme);
    return { id: def?.id ?? "", name: def?.name ?? "" };
  }

  /**
   * POST /__mock/themes/edit?theme=<id>&<base key>=<#hex>…: a save of one of the user's
   * themes from outside this window (the CLI, a thread, another window), base colours changed.
   */
  edit(q: URLSearchParams): { ok: true } {
    const u = this.user.find((t) => t.id === q.get("theme"));
    if (!u) throw new Error("want theme=<one of the user's themes>");
    const base = { ...u.base };
    for (const [k, v] of q) if (k !== "theme") (base as unknown as Record<string, string>)[k] = v;
    this.save({ ...u, base });
    return { ok: true };
  }

  /** POST /__mock/themes?set=empty|seed: the directory, as a hand edit. */
  control(q: URLSearchParams): { themes: number } {
    const set = q.get("set");
    if (set === "empty") {
      this.user = [];
      this.issues = [];
    } else if (set === "seed") {
      this.user = seed();
      this.issues = [...SEED_ISSUES];
    } else throw new CommandError("invalid", "set must be empty or seed");
    this.changed();
    return { themes: this.user.length };
  }
}
