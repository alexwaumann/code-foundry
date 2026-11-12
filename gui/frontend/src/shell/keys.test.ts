import { describe, expect, it } from "vitest";
import spec from "../../../../docs/notes/shell-model.md?raw";
import { normalizeChord } from "@/keys/chord";
import { SHELL_KEYS, shellKeyFor } from "./keys";

/** The spec's key table (docs/notes/shell-model.md, "Keys"): each row's Key cell and Does cell. */
function specRows(): { key: string; does: string }[] {
  const md = spec;
  const section = md.slice(md.indexOf("## Keys"), md.indexOf("\n## ", md.indexOf("## Keys") + 1));
  return section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Key") && !l.startsWith("| ---"))
    .map((l) => {
      const [, key = "", does = ""] = l.split("|").map((c) => c.trim());
      return { key, does };
    });
}

/** A Key cell's chords: "a / b" is two, "ctrl+cmd+h j k l, ctrl+cmd+arrows" the four letters and four arrows. */
function chordsOf(cell: string): string[] {
  return cell.split(/ \/ |, /).flatMap((part) => {
    const letters = /^(.*\+)([a-z])((?: [a-z])+)$/.exec(part);
    if (letters) return [letters[2] ?? "", ...(letters[3] ?? "").trim().split(" ")].map((k) => `${letters[1] ?? ""}${k}`);
    if (part.endsWith("+arrows")) return ["left", "down", "up", "right"].map((a) => part.replace(/arrows$/, a));
    if (part.endsWith("+1…9")) return Array.from({ length: 9 }, (_, i) => part.replace(/1…9$/, String(i + 1)));
    return [part];
  });
}

/** With shift, a row whose Does says "with shift, move the pane" moves the pane. */
const withShift = (c: string) => c.replace(/\+([^+]+)$/, "+shift+$1");

// The verb each implemented row's chords run, in the spec's chord order.
const WANT: Readonly<Record<string, readonly string[]>> = {
  "cmd+w": ["tab.close"],
  "cmd+shift+w": ["pane.close"],
  "cmd+shift+[ / cmd+shift+]": ["tab.previous", "tab.next"],
  "ctrl+cmd+h j k l, ctrl+cmd+arrows": ["pane.focus.left", "pane.focus.down", "pane.focus.up", "pane.focus.right"],
  "cmd+t": ["terminal.new"],
  "cmd+shift+t": ["terminal.new-free"],
  "cmd+j": ["terminal.quick"],
  "cmd+shift+j": ["terminal.cycle"],
  // cmd+r on a thread's tab is today's rename (thread.rename's inline field); on a terminal's, tab.rename.
  "cmd+r": ["tab.rename"],
  "cmd+shift+r": ["tab.rename"],
  "cmd+shift+d": ["view.thread-diff"],
  "cmd+shift+i": ["view.thread-info"],
  "cmd+[ / cmd+]": ["view.back", "view.forward"],
  "ctrl+cmd+1…9": ["space.switch"],
  "cmd+shift+enter": ["pane.fullscreen"],
};

describe("the interim key table against the spec's", () => {
  const rows = specRows();

  it("reads the spec's table", () => {
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.map((r) => r.key)).toContain("cmd+w");
  });

  it("names only rows of the spec, verbatim", () => {
    const keys = new Set(rows.map((r) => r.key));
    for (const k of SHELL_KEYS) expect(keys, k.spec).toContain(k.spec);
  });

  it("implements the rows of this PR with each of their chords, to the right verb", () => {
    for (const [cell, verbs] of Object.entries(WANT)) {
      const chords = chordsOf(cell).map((c) => normalizeChord(c) ?? c);
      // h j k l and the arrows go the same four ways.
      const perVerb = chords.length / verbs.length;
      chords.forEach((c, i) => {
        expect(shellKeyFor(c)?.command, c).toBe(verbs[i % verbs.length]);
        expect(shellKeyFor(c)?.spec, c).toBe(cell);
      });
      expect(perVerb).toBe(Math.round(perVerb));
    }
  });

  it("with shift, the pane keys move the pane, as the row's text says", () => {
    const row = rows.find((r) => r.key === "ctrl+cmd+h j k l, ctrl+cmd+arrows");
    expect(row?.does).toContain("with shift, move the pane");
    const chords = chordsOf(row?.key ?? "").map((c) => normalizeChord(withShift(c)) ?? c);
    expect(chords.map((c) => shellKeyFor(c)?.command)).toEqual(["left", "down", "up", "right", "left", "down", "up", "right"].map((d) => `pane.move.${d}`));
  });

  it("has nothing but those rows (the other keys arrive with their PRs)", () => {
    const want = new Set(Object.keys(WANT));
    for (const k of SHELL_KEYS) expect(want, k.spec).toContain(k.spec);
    const all = SHELL_KEYS.flatMap((k) => k.chords);
    expect(new Set(all).size).toBe(all.length);
  });
});
