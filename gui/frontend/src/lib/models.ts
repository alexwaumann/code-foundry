/**
 * Model choices and names. The list comes from the daemon's model registry
 * (internal/model) through the settings schema: sessions.default_model's enum values and
 * labels. FALLBACK_MODEL_CHOICES only covers the moment before the schema has loaded (or a
 * daemon without settings).
 */
import type { SettingFieldView } from "@/api/settings";
import { DEFAULT_MODEL, type Choice } from "./compose";

/** The settings field whose enum is the model registry. */
export const MODEL_SETTING_KEY = "sessions.default_model";

/** The registry's default model alone, until the schema arrives. */
export const FALLBACK_MODEL_CHOICES: readonly Choice[] = [{ value: DEFAULT_MODEL, label: "Opus 4.8" }];

/** An enum value's display name: its label from the schema, else the value itself. */
export function enumOptionLabel(f: Pick<SettingFieldView, "enumValues" | "enumLabels">, value: string): string {
  const i = f.enumValues.indexOf(value);
  return (i >= 0 ? f.enumLabels[i] : "") || value;
}

/** The model choices a settings schema offers (blank "no preference" values dropped); null without the field. */
export function modelChoicesFromSchema(fields: readonly Pick<SettingFieldView, "key" | "enumValues" | "enumLabels">[]): readonly Choice[] | null {
  const f = fields.find((x) => x.key === MODEL_SETTING_KEY);
  if (!f) return null;
  const out = f.enumValues.filter((v) => v !== "").map((v) => ({ value: v, label: enumOptionLabel(f, v) }));
  return out.length > 0 ? out : null;
}

/** A model's name: its registry label, else the raw value (any full model name is accepted). */
export function modelName(choices: readonly Choice[], model: string): string {
  return choices.find((c) => c.value === model)?.label ?? model;
}

const CANONICAL = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[[^\]]*\])?$/;

/**
 * The name of a model as Claude reports it (a turn's replies: "claude-haiku-5-5",
 * "claude-opus-4-8[1m]"): the registry's label for that id, else the registry's label for
 * its family alias with the version read from the id ("Haiku" + "5.5"), else the id itself.
 */
export function canonicalModelName(choices: readonly Choice[], id: string): string {
  const known = choices.find((c) => c.value === id);
  if (known) return known.label;
  const m = CANONICAL.exec(id);
  if (!m) return id;
  const [, family = "", major = "", minor] = m;
  const label = choices.find((c) => c.value === family)?.label ?? family.charAt(0).toUpperCase() + family.slice(1);
  return `${label} ${major}${minor ? `.${minor}` : ""}`;
}
