/**
 * A form's values and the host's checks (PRIMITIVES.md §A "form"): drafts are the fields
 * the user changed; a pristine field shows (and submits) the plugin's value. A secret is
 * never echoed: it submits only what the user typed, and only in a submit.
 */
import type { Field, FieldValue, FormNodeData } from "@/api/plugin";
import { dateError } from "./date";

/** The fields that carry values: a fieldset's fields in its place. */
export function flatFields(fields: readonly Field[]): Field[] {
  return fields.flatMap((f) => (f.fieldset ? f.fieldset.fields : [f]));
}

/** What the plugin's view says a field holds (a secret: nothing). */
export function pluginValue(f: Field): FieldValue | undefined {
  if (f.input) return f.input.kind === "secret" ? "" : (f.input.value ?? "");
  if (f.select) return f.select.multiple ? [...(f.select.value ?? [])] : (f.select.value?.[0] ?? "");
  if (f.toggle) return f.toggle.value;
  return undefined;
}

export function isSecret(f: Field): boolean {
  return f.input?.kind === "secret";
}

/** A field's value now: its draft, else the plugin's. */
export function fieldValue(f: Field, drafts: Readonly<Record<string, FieldValue>> | undefined): FieldValue | undefined {
  const name = f.name ?? "";
  const d = name ? drafts?.[name] : undefined;
  return d ?? pluginValue(f);
}

/**
 * The values a form sends: every named field's value; a secret only when the user typed
 * one and `withSecrets` (a submit). Disabled fields are left out.
 */
export function formValues(form: FormNodeData, drafts: Readonly<Record<string, FieldValue>> | undefined, withSecrets: boolean): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const f of flatFields(form.fields)) {
    if (!f.name || f.disabled) continue;
    if (isSecret(f)) {
      const typed = drafts?.[f.name];
      if (withSecrets && typeof typed === "string" && typed !== "") out[f.name] = typed;
      continue;
    }
    const v = fieldValue(f, drafts);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/** How long typing pauses before a live input sends its change event, in ms. */
export const LIVE_CHANGE_MS = 300;

/** A live input's change events: see liveSender. */
export interface LiveSender {
  /** The text changed: send it once typing pauses. */
  push: (value: string) => void;
  /** Send what is waiting now (focus left, Enter). */
  flush: () => void;
  /** Forget what is waiting (the field went). */
  cancel: () => void;
}

/**
 * Sends a live input's text as it is typed: after a pause, one at a time, so a plugin never
 * answers an older filter after a newer one, and the latest text always goes last. The same
 * text twice running goes once.
 */
export function liveSender(send: (value: string) => Promise<unknown>, delay = LIVE_CHANGE_MS): LiveSender {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: string | undefined;
  let last: string | undefined;
  let sending = false;
  const fire = () => {
    clearTimeout(timer);
    timer = undefined;
    if (sending || waiting === undefined) return;
    const value = waiting;
    waiting = undefined;
    if (value === last) return;
    last = value;
    sending = true;
    void send(value).finally(() => {
      sending = false;
      if (timer === undefined) fire();
    });
  };
  return {
    push: (value) => {
      waiting = value;
      clearTimeout(timer);
      timer = setTimeout(fire, delay);
    },
    flush: fire,
    cancel: () => {
      clearTimeout(timer);
      timer = undefined;
      waiting = undefined;
    },
  };
}

/** A value as a command argument or a change event's value: lists comma-joined. */
export function valueString(v: FieldValue): string {
  return Array.isArray(v) ? v.join(",") : String(v);
}

/** A field's pattern as a RegExp; null when JavaScript cannot read it (the host then skips the check). */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return null;
  }
}

/** The host's check of one field (required, max length, pattern, a date's form and bounds); null when it passes. */
export function validateField(f: Field, v: FieldValue | undefined): string | null {
  if (f.disabled) return null;
  const empty = v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  if (f.required && empty && !(isSecret(f) && f.input?.hasValue)) return "Required";
  if (typeof v !== "string" || !f.input || v === "") return null;
  if (f.input.kind === "date") return dateError(v, f.input.min, f.input.max);
  if (f.input.maxLength && v.length > f.input.maxLength) return `At most ${String(f.input.maxLength)} characters`;
  const re = f.input.pattern ? compile(f.input.pattern) : null;
  if (re && !re.test(v)) return f.input.patternMessage || "Not in the expected form";
  return null;
}

/** Every field's host error, by name (empty when the form may submit). */
export function validateForm(form: FormNodeData, drafts: Readonly<Record<string, FieldValue>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flatFields(form.fields)) {
    if (!f.name) continue;
    const err = validateField(f, isSecret(f) ? drafts?.[f.name] : fieldValue(f, drafts));
    if (err) out[f.name] = err;
  }
  return out;
}
