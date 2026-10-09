/**
 * Client-side checks for the settings form, for instant inline feedback. They mirror
 * internal/store/settings (Field.parse) and internal/command/chord.go (ValidateBinding);
 * the daemon re-validates every change and its answer wins.
 */
import type { SettingFieldView } from "@/api/settings";
import { isViewActionChord } from "@/keys/bindings";
import { isEditingChord, normalizeChord } from "@/keys/chord";

export type Validated = { ok: true; value: string } | { ok: false; error: string };

/**
 * Chords the Wails app menu takes (gui/app.go appMenu; ReservedChords in chord.go), plus
 * the side panel's own chords: cmd+w (close the active tab) and cmd+shift+c (copy a pull
 * request's link).
 */
const menuChords = new Set(["cmd+w", "cmd+shift+c", "cmd+q", "cmd+h", "cmd+alt+h", "cmd+m", "cmd+ctrl+f"]);

const keyPattern =
  /^([a-z0-9]|enter|escape|tab|space|backspace|delete|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|f([1-9]|1[0-2])|[,./=\-[\];'`\\])$/;

/** True for chords the app reserves (view actions, editing chords, menu chords). */
export function isReservedChord(chord: string): boolean {
  return isViewActionChord(chord) || isEditingChord(chord) || menuChords.has(chord);
}

/** Validates a keybinding value: a chord a command may bind, or "none". */
export function validateKeybinding(raw: string): Validated {
  const v = raw.trim();
  if (v.toLowerCase() === "none") return { ok: true, value: "none" };
  const c = normalizeChord(v);
  const key = c?.split("+").pop() ?? "";
  if (!c || !keyPattern.test(key)) return { ok: false, error: `${v} is not a shortcut this app can match` };
  if (isReservedChord(c)) return { ok: false, error: `${c} is reserved by the app` };
  const bare = c.replace(/^shift\+/, "");
  if (!bare.includes("+") && !/^f([1-9]|1[0-2])$/.test(bare)) return { ok: false, error: `${c} needs cmd, ctrl, or alt (a bare key would steal typing)` };
  return { ok: true, value: c };
}

/** Validates and canonicalizes a raw input for a field. "" means "reset to default". */
export function validateSetting(f: SettingFieldView, raw: string): Validated {
  if (raw === "") return { ok: true, value: "" };
  switch (f.type) {
    case "int": {
      const s = raw.trim();
      if (!/^-?\d+$/.test(s)) return { ok: false, error: `Want a whole number, got "${raw}"` };
      const n = Number(s);
      if (n < f.min || n > f.max) return { ok: false, error: `Want ${String(f.min)} to ${String(f.max)}` };
      return { ok: true, value: String(n) };
    }
    case "bool":
      return raw === "true" || raw === "false" ? { ok: true, value: raw } : { ok: false, error: "Want true or false" };
    case "enum":
      return f.enumValues.includes(raw) ? { ok: true, value: raw } : { ok: false, error: `Want one of ${f.enumValues.join(", ")}` };
    case "path":
      return raw.startsWith("/") || raw === "~" || raw.startsWith("~/") ? { ok: true, value: raw } : { ok: false, error: "Want an absolute path (or ~/…)" };
    case "keybinding":
      return validateKeybinding(raw);
    default:
      return { ok: true, value: raw };
  }
}
