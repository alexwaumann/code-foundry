import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import spec from "../../../../docs/notes/shell-model.md?raw";
import type { CommandView } from "@/api/command";

// The shell's presenters, recorded: which verb a chord reached (the presenters themselves are
// shell/*'s tests'). Everything else in bindings.ts is real.
const presented: string[] = [];
vi.mock("@/shell/keyPresenters", async (orig) => {
  const real = await orig<typeof import("@/shell/keyPresenters")>();
  return {
    ...real,
    presentShellCommand: (name: string, args?: Record<string, string>) => {
      if (!(name in real.SHELL_PRESENTERS) || (args && Object.keys(args).length > 0)) return undefined;
      presented.push(name);
      return true;
    },
  };
});
const switched: number[] = [];
vi.mock("@/shell/spaceActions", async (orig) => ({
  ...(await orig<typeof import("@/shell/spaceActions")>()),
  switchSpaceAt: (n: number) => {
    switched.push(n);
  },
}));

const { commandBindings, handleKeyDown, hasShellPresenter, isViewActionChord } = await import("./bindings");
const { normalizeChord } = await import("./chord");
const { SHELL_PRESENTERS } = await import("@/shell/keyPresenters");
const { useCommandsStore } = await import("@/stores/commands");
const { contextKey, getUiContext } = await import("@/stores/context");
const { resetShellView, setShellMode } = await import("@/stores/shellView");
const { helpSections } = await import("./help");
const { viewActions } = await import("./bindings");

/** The spec's key table (docs/notes/shell-model.md, "Keys"): each row's Key cell. */
function specKeys(): string[] {
  const at = spec.indexOf("## Keys");
  const section = spec.slice(at, spec.indexOf("\n## ", at + 1));
  return section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Key") && !l.startsWith("| ---"))
    .map((l) => l.split("|")[1]?.trim() ?? "");
}

/** A Key cell's chords, as internal/command keybindings_test.go specChords reads them. */
function chordsOf(cell: string): string[] {
  return cell.split(/ \/ |, /).flatMap((part) => {
    const letters = /^(.*\+)([a-z])((?: [a-z])+)$/.exec(part);
    if (letters) return [letters[2] ?? "", ...(letters[3] ?? "").trim().split(" ")].map((k) => `${letters[1] ?? ""}${k}`);
    if (part.endsWith("+arrows")) return ["left", "down", "up", "right"].map((a) => part.replace(/arrows$/, a));
    if (part.endsWith("+1…9")) return Array.from({ length: 9 }, (_, i) => part.replace(/1…9$/, String(i + 1)));
    return [part];
  });
}

const VIEW = "(view action)";

/** The verbs of each row, as internal/command TestShellKeyTable has them. */
const WANT: Readonly<Record<string, readonly string[]>> = {
  "cmd+n": ["thread.new"],
  "cmd+t": ["terminal.new"],
  "cmd+shift+t": ["tab.reopen"],
  "cmd+j": ["terminal.quick"],
  "cmd+shift+j": ["terminal.cycle"],
  "cmd+shift+d": ["view.thread-diff"],
  "cmd+shift+i": ["view.thread-info"],
  "cmd+p": ["file.find"],
  "cmd+k": [VIEW],
  "cmd+w": ["tab.close"],
  "cmd+shift+w": ["pane.close"],
  "cmd+[ / cmd+]": ["view.back", "view.forward"],
  "cmd+shift+[ / cmd+shift+]": ["tab.previous", "tab.next"],
  "ctrl+cmd+h j k l, ctrl+cmd+arrows": ["pane.focus.left", "pane.focus.down", "pane.focus.up", "pane.focus.right"],
  "ctrl+cmd+1…9": [VIEW],
  "cmd+1…9": [VIEW],
  "cmd+shift+enter": ["pane.fullscreen"],
  "cmd+shift+m": ["pane.collapse"],
  "cmd+shift+a": [VIEW],
  "cmd+r": ["tab.rename"],
  "cmd+shift+r": ["tab.auto-name"],
  "cmd+b": [VIEW],
};

/** Every chord of the table with the verb it runs (a VIEW for the GUI's own). */
function table(): [string, string][] {
  return specKeys().flatMap((cell) => {
    const verbs = WANT[cell] ?? [];
    const rows = chordsOf(cell).map((c, i): [string, string] => [normalizeChord(c) ?? c, verbs[i % verbs.length] ?? "?"]);
    // "with shift, move the pane"
    if (cell.startsWith("ctrl+cmd+h")) return [...rows, ...rows.map(([c, v]): [string, string] => [c.replace("cmd+ctrl+", "cmd+ctrl+shift+"), v.replace("pane.focus.", "pane.move.")])];
    return rows;
  });
}

// The daemon's list for the table's verbs: each with its chords (internal/command TestShellKeyTable
// pins the daemon's defaults to the spec's table, mock/keymap.test.ts the mock's to the daemon's).
const commands: CommandView[] = (() => {
  const chords = new Map<string, string[]>();
  for (const [chord, verb] of table()) if (verb !== VIEW) chords.set(verb, [...(chords.get(verb) ?? []), chord]);
  return [...chords].map(([name, keybindings]): CommandView => ({ name, title: name, description: "", category: "Layout", args: [], keybindings, available: true }));
})();

beforeEach(() => {
  useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext()) });
  setShellMode("shell");
  presented.length = 0;
  switched.length = 0;
});

afterEach(() => {
  resetShellView();
});

describe("the spec's key table in the window's keymap", () => {
  it("covers every row of the spec", () => {
    expect(specKeys().sort()).toEqual(Object.keys(WANT).sort());
  });

  it("leaves the view actions' chords to the GUI, and the window presents each verb", () => {
    const bound = commandBindings(commands);
    for (const [chord, verb] of table()) {
      if (verb === VIEW) {
        expect(isViewActionChord(chord), chord).toBe(true);
        expect(bound.get(chord), chord).toBeUndefined();
        continue;
      }
      expect(bound.get(chord)?.name, chord).toBe(verb);
      expect(hasShellPresenter(verb), verb).toBe(true);
    }
  });

  it("a key press reaches the shell's presenter of its verb, in the content, a prompt or a terminal", () => {
    const where = {
      content: Object.assign(document.createElement("div"), { tabIndex: 0 }),
      prompt: Object.assign(document.createElement("div"), { contentEditable: "true" }),
      terminal: document.createElement("textarea"),
    };
    where.content.setAttribute("data-region", "content");
    const yield_ = document.createElement("div");
    yield_.setAttribute("data-chord-yield", "");
    yield_.append(where.prompt);
    const host = document.createElement("div");
    host.setAttribute("data-terminal-host", "");
    host.append(where.terminal);
    document.body.append(where.content, yield_, host);
    for (const target of Object.values(where)) {
      for (const [chord, verb] of table().filter(([, v]) => v in SHELL_PRESENTERS)) {
        presented.length = 0;
        const parts = chord.split("+");
        const key = parts.at(-1) ?? "";
        const code = /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === "[" ? "BracketLeft" : key === "]" ? "BracketRight" : "";
        const name = key.startsWith("arrow") ? `Arrow${key.slice(5, 6).toUpperCase()}${key.slice(6)}` : key === "enter" ? "Enter" : key;
        const ev = new KeyboardEvent("keydown", { key: name, code, metaKey: parts.includes("cmd"), ctrlKey: parts.includes("ctrl"), altKey: parts.includes("alt"), shiftKey: parts.includes("shift"), bubbles: true, cancelable: true });
        Object.defineProperty(ev, "target", { value: target });
        handleKeyDown(ev);
        expect(presented, `${chord} in ${target.tagName}`).toEqual([verb]);
      }
    }
    for (const el of [where.content, yield_, host]) el.remove();
  });

  it("ctrl+cmd+1…9 switch to that space", () => {
    for (let n = 1; n <= 9; n++) {
      const ev = new KeyboardEvent("keydown", { key: String(n), code: `Digit${String(n)}`, metaKey: true, ctrlKey: true, bubbles: true, cancelable: true });
      handleKeyDown(ev);
    }
    expect(switched).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("the keyboard help lists every chord of the table", () => {
    const listed = new Set(helpSections(commands, viewActions).flatMap((s) => s.items.flatMap((i) => i.keys)));
    for (const [chord] of table()) {
      // A numbered view action is one row: ⌘1–9, ⌃⌘1–9.
      const glyph = helpGlyph(chord);
      expect(listed.has(glyph), `${chord} (${glyph})`).toBe(true);
    }
  });
});

/** The help's glyphs for a chord (keys/help.ts): numbered view actions share a 1–9 row. */
function helpGlyph(chord: string): string {
  const mods = chord.split("+");
  const key = mods.pop() ?? "";
  const sym: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
  const g = (m: string) => (mods.includes(m) ? (sym[m] ?? "") : "");
  const glyphs: Record<string, string> = { enter: "↵", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→" };
  const k = /^\d$/.test(key) ? "1–9" : (glyphs[key] ?? key.toUpperCase());
  return `${g("ctrl")}${g("alt")}${g("shift")}${g("cmd")}${k}`;
}
