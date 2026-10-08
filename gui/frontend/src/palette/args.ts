import type { ArgSpecView, CommandView } from "@/api/command";

/**
 * Args the palette prompts for: required ones, plus enums (a pick list costs one Enter on
 * the highlighted default, and is how session.new offers model/effort from its ArgSpec).
 * Other optional args take daemon defaults.
 */
export function promptedArgs(c: CommandView): ArgSpecView[] {
  return c.args.filter((a) => a.required || a.type === "enum");
}

/** Pick-list value for "leave this optional arg unset" (an enum without a default). */
export const UNSET_CHOICE = "__unset";

export type ArgResult = { ok: true; value: string } | { ok: false; error: string };

const truthy = new Set(["true", "yes", "y", "1", "on"]);
const falsy = new Set(["false", "no", "n", "0", "off"]);

/**
 * Validates and normalizes one raw palette input for an arg. Paths are passed through
 * untouched: "~" expansion happens daemon-side.
 */
export function validateArg(spec: ArgSpecView, raw: string): ArgResult {
  if (raw === UNSET_CHOICE && !spec.required) return { ok: true, value: "" };
  const v = spec.type === "string" ? raw : raw.trim();
  if (v === "") {
    if (spec.defaultValue !== "") return { ok: true, value: spec.defaultValue };
    return spec.required ? { ok: false, error: `${spec.name} is required` } : { ok: true, value: "" };
  }
  switch (spec.type) {
    case "int":
      return /^-?\d+$/.test(v) ? { ok: true, value: String(Number.parseInt(v, 10)) } : { ok: false, error: `${spec.name} must be a whole number` };
    case "bool": {
      const lower = v.toLowerCase();
      if (truthy.has(lower)) return { ok: true, value: "true" };
      if (falsy.has(lower)) return { ok: true, value: "false" };
      return { ok: false, error: `${spec.name} must be true or false` };
    }
    case "enum":
      return spec.enumValues.includes(v)
        ? { ok: true, value: v }
        : { ok: false, error: `${spec.name} must be one of ${spec.enumValues.join(", ")}` };
    case "string":
    case "path":
      return { ok: true, value: v };
  }
}

/** Fixed choices to list for an arg, or null for free text. */
export function argChoices(spec: ArgSpecView): string[] | null {
  if (spec.type === "enum") return !spec.required && spec.defaultValue === "" ? [UNSET_CHOICE, ...spec.enumValues] : spec.enumValues;
  if (spec.type === "bool") return spec.defaultValue === "true" ? ["true", "false"] : ["false", "true"];
  return null;
}

export interface ArgPrompt {
  command: CommandView;
  specs: ArgSpecView[];
  index: number;
  values: Record<string, string>;
}

export type ArgStep = { kind: "next"; prompt: ArgPrompt } | { kind: "done"; values: Record<string, string> } | { kind: "error"; error: string };

export function startPrompt(command: CommandView): ArgPrompt {
  return { command, specs: promptedArgs(command), index: 0, values: {} };
}

/** Applies the input for the current arg and advances. */
export function submitArg(p: ArgPrompt, raw: string): ArgStep {
  const spec = p.specs[p.index];
  if (!spec) return { kind: "done", values: p.values };
  const r = validateArg(spec, raw);
  if (!r.ok) return { kind: "error", error: r.error };
  // An optional arg left empty is not sent, so the daemon applies its own default.
  const values = r.value === "" && !spec.required ? { ...p.values } : { ...p.values, [spec.name]: r.value };
  if (p.index + 1 >= p.specs.length) return { kind: "done", values };
  return { kind: "next", prompt: { ...p, index: p.index + 1, values } };
}

/** Goes back one arg; null when already at the first (leave arg mode). */
export function previousArg(p: ArgPrompt): ArgPrompt | null {
  if (p.index === 0) return null;
  const prev = p.specs[p.index - 1];
  const values = Object.fromEntries(Object.entries(p.values).filter(([k]) => k !== prev?.name));
  return { ...p, index: p.index - 1, values };
}

/** Groups commands by category, categories and commands sorted by title. */
export function groupByCategory(commands: readonly CommandView[]): [string, CommandView[]][] {
  const groups = new Map<string, CommandView[]>();
  for (const c of commands) {
    const list = groups.get(c.category);
    if (list) list.push(c);
    else groups.set(c.category, [c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, list]) => [cat, list.sort((a, b) => a.title.localeCompare(b.title))]);
}
