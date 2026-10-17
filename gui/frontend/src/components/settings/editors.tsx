/** The per-type setting editors (useSettingField picks one, after keyEditors). */
import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { chordFromEvent, formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import type { EditorProps } from "./editor";
import { enumLabel } from "./model";

export function BoolEditor({ field, value, pending, commit }: EditorProps) {
  const on = value === "true";
  return (
    <Switch
      aria-label={field.title}
      checked={on}
      disabled={pending}
      onCheckedChange={(checked) => {
        commit(checked ? "true" : "false");
      }}
    />
  );
}

/**
 * Radix Select reserves "" for "no value" (an item cannot have it), and "" is an enum's
 * "no preference" (Default); the list uses this stand-in for it.
 */
const EMPTY_ENUM = "__cf_default__";

/**
 * `markDefault` (on) appends " (default)" to the default's label; the theme slot rows turn it
 * off to leave room for their Choose… button (the reset arrow already marks a changed value).
 */
export function EnumEditor({ field, value, pending, invalid, commit, markDefault = true }: EditorProps & { markDefault?: boolean }) {
  const toItem = (v: string) => (v === "" ? EMPTY_ENUM : v);
  return (
    <Select
      value={toItem(value)}
      disabled={pending}
      onValueChange={(v) => {
        commit(v === EMPTY_ENUM ? "" : v);
      }}
    >
      <SelectTrigger className="w-full" aria-label={field.title} aria-invalid={invalid || undefined} data-value={value}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {field.enumValues.map((v) => (
          <SelectItem key={v} value={toItem(v)}>
            {enumLabel(field, v)}
            {markDefault && v === field.defaultValue && v !== "" ? " (default)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Text and number inputs commit on Enter or blur; Escape reverts. A number input is
 * narrow and right-aligned, with the field's unit ("s", "%") as a muted suffix inside it.
 */
export function TextEditor({ field, value, pending, invalid, commit, setError }: EditorProps) {
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.value = value;
      setError(null);
      e.currentTarget.blur();
    }
  };
  const number = field.type === "int";
  const input = (
    <Input
      // Remount on a new daemon value (e.g. the file was edited by hand).
      key={value}
      aria-label={field.title}
      aria-invalid={invalid || undefined}
      className={cn(
        (field.type === "path" || field.type === "string") && "text-body-sm font-mono",
        // No stepper arrows: they would sit on the unit.
        number && "text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
      )}
      // Room for the unit: its width in ch, the input's own padding and a gap.
      style={number && field.unit ? { paddingRight: `calc(${String(field.unit.length)}ch + 1rem)` } : undefined}
      type={number ? "number" : "text"}
      min={number ? field.min : undefined}
      max={number ? field.max : undefined}
      defaultValue={value}
      placeholder={field.placeholder || field.defaultValue}
      disabled={pending}
      spellCheck={false}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (e.currentTarget.value !== value) commit(e.currentTarget.value);
      }}
    />
  );
  if (!number) return input;
  return (
    <div className="relative w-34">
      {input}
      {field.unit && (
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-caption" aria-hidden data-testid="setting-unit">
          {field.unit}
        </span>
      )}
    </div>
  );
}

/** Click, then press the shortcut. Esc cancels, Backspace unbinds. */
export function KeybindingEditor({ field, value, pending, invalid, commit, setError }: EditorProps) {
  const [recording, setRecording] = useState(false);
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) return; // a bare modifier: keep waiting
    e.preventDefault();
    e.stopPropagation();
    setRecording(false);
    if (chord === "escape") return;
    commit(chord === "backspace" || chord === "delete" ? "none" : chord);
  };
  const bound = value !== "" && value !== "none";
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-key-recorder
      aria-label={`${field.title} shortcut`}
      aria-invalid={invalid || undefined}
      disabled={pending}
      className={cn("w-full justify-between px-2.5 font-normal", recording && "border-ring ring-[3px] ring-ring/50")}
      onClick={(e) => {
        // WebKit does not focus a button on click; the recorder needs the keydowns.
        e.currentTarget.focus();
        setError(null);
        setRecording((r) => !r);
      }}
      onBlur={() => {
        setRecording(false);
      }}
      onKeyDown={onKey}
    >
      {recording ? (
        <span className="text-caption">Press a shortcut… (Esc cancels, ⌫ unbinds)</span>
      ) : (
        <span className={bound ? "" : "text-muted-foreground"}>{bound ? formatChord(value) : "Add shortcut"}</span>
      )}
    </Button>
  );
}

