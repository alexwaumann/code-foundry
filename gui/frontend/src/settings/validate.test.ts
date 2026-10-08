import { describe, expect, it } from "vitest";
import type { SettingFieldView } from "@/api/settings";
import { validateKeybinding, validateSetting } from "./validate";

function field(over: Partial<SettingFieldView>): SettingFieldView {
  return { key: "g.k", title: "K", description: "", group: "g", type: "string", enumValues: [], defaultValue: "", restartRequired: false, min: 0, max: 0, placeholder: "", ...over };
}

describe("validateSetting", () => {
  it.each([
    ["empty resets", field({ type: "int", min: 1, max: 5 }), "", { ok: true, value: "" }],
    ["int in range", field({ type: "int", min: 9, max: 28 }), " 14 ", { ok: true, value: "14" }],
    ["int too big", field({ type: "int", min: 9, max: 28 }), "99", { ok: false, error: "Want 9 to 28" }],
    ["int not a number", field({ type: "int", min: 9, max: 28 }), "13.5", { ok: false, error: 'Want a whole number, got "13.5"' }],
    ["enum", field({ type: "enum", enumValues: ["", "opus"] }), "opus", { ok: true, value: "opus" }],
    ["enum unknown", field({ type: "enum", enumValues: ["dark", "light"] }), "blue", { ok: false, error: "Want one of dark, light" }],
    ["bool", field({ type: "bool" }), "false", { ok: true, value: "false" }],
    ["path absolute", field({ type: "path" }), "/opt/bin/claude", { ok: true, value: "/opt/bin/claude" }],
    ["path tilde", field({ type: "path" }), "~/wt/{repo}", { ok: true, value: "~/wt/{repo}" }],
    ["path relative", field({ type: "path" }), "bin/claude", { ok: false, error: "Want an absolute path (or ~/…)" }],
    ["string verbatim", field({}), "  Iosevka ", { ok: true, value: "  Iosevka " }],
  ])("%s", (_name, f, raw, want) => {
    expect(validateSetting(f, raw)).toEqual(want);
  });
});

describe("validateKeybinding", () => {
  it.each([
    ["normalizes", "Shift+Cmd+N", { ok: true, value: "cmd+shift+n" }],
    ["none unbinds", "NONE", { ok: true, value: "none" }],
    ["function key alone", "f5", { ok: true, value: "f5" }],
    ["view action is reserved", "cmd+k", { ok: false, error: "cmd+k is reserved by the app" }],
    ["jump is reserved", "cmd+3", { ok: false, error: "cmd+3 is reserved by the app" }],
    ["editing chord is reserved", "cmd+c", { ok: false, error: "cmd+c is reserved by the app" }],
    ["menu chord is reserved", "cmd+w", { ok: false, error: "cmd+w is reserved by the app" }],
    ["bare letter", "x", { ok: false, error: "x needs cmd, ctrl, or alt (a bare key would steal typing)" }],
    ["shift letter", "shift+x", { ok: false, error: "shift+x needs cmd, ctrl, or alt (a bare key would steal typing)" }],
    ["unknown key", "cmd+π", { ok: false, error: "cmd+π is not a shortcut this app can match" }],
  ])("%s", (_name, raw, want) => {
    expect(validateKeybinding(raw)).toEqual(want);
  });
});
