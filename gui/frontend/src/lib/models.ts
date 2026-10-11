/**
 * Model choices and names. The list comes from the daemon's model registry
 * (internal/model) through the settings schema: sessions.default_model's enum values and
 * labels. Nothing here names a model version; FALLBACK_MODEL_CHOICES only covers the
 * moment before the schema has loaded (or a daemon without settings).
 */
import type { SettingFieldView } from "@/api/settings";
import type { Choice } from "./compose";

/** The settings field whose enum is the model registry. */
export const MODEL_SETTING_KEY = "sessions.default_model";

/** The family aliases, until the schema arrives. Claude Code resolves each to its default. */
export const FALLBACK_MODEL_CHOICES: readonly Choice[] = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

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
