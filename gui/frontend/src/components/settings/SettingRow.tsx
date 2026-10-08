import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import type { SettingFieldView } from "@/api/settings";
import { chordFromEvent, formatChord } from "@/keys/chord";
import { validateSetting } from "@/settings/validate";
import { saveSettings, useSettingsStore, useSettingValue } from "@/stores/settings";

const inputClass =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 aria-invalid:border-destructive";

/** "" in an enum means "no preference" (e.g. Claude's default model). */
function enumLabel(v: string): string {
  return v === "" ? "Default" : v;
}

function displayValue(f: SettingFieldView, v: string): string {
  if (f.type === "keybinding") return v === "none" ? "unbound" : v ? formatChord(v) : "unbound";
  if (f.type === "enum") return enumLabel(v);
  return v === "" ? "default" : v;
}

interface EditorProps {
  field: SettingFieldView;
  value: string;
  pending: boolean;
  invalid: boolean;
  commit: (raw: string) => void;
  setError: (e: string | null) => void;
}

function BoolEditor({ field, value, pending, commit }: EditorProps) {
  const on = value === "true";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={field.title}
      disabled={pending}
      onClick={() => {
        commit(on ? "false" : "true");
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        on ? "bg-primary" : "bg-input",
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-background shadow transition-transform", on ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

function EnumEditor({ field, value, pending, commit }: EditorProps) {
  return (
    <select
      aria-label={field.title}
      className={inputClass}
      value={value}
      disabled={pending}
      onChange={(e) => {
        commit(e.target.value);
      }}
    >
      {field.enumValues.map((v) => (
        <option key={v} value={v}>
          {enumLabel(v)}
          {v === field.defaultValue ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}

/** Text and number inputs commit on Enter or blur; Escape reverts. */
function TextEditor({ field, value, pending, invalid, commit, setError }: EditorProps) {
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
  return (
    <input
      // Remount on a new daemon value (e.g. the file was edited by hand).
      key={value}
      aria-label={field.title}
      aria-invalid={invalid || undefined}
      className={cn(inputClass, field.type === "path" || field.type === "string" ? "font-mono text-xs" : "")}
      type={field.type === "int" ? "number" : "text"}
      min={field.type === "int" ? field.min : undefined}
      max={field.type === "int" ? field.max : undefined}
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
}

/** Click, then press the shortcut. Esc cancels, Backspace unbinds. */
function KeybindingEditor({ field, value, pending, invalid, commit, setError }: EditorProps) {
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
  return (
    <button
      type="button"
      data-key-recorder
      aria-label={`${field.title} shortcut`}
      aria-invalid={invalid || undefined}
      disabled={pending}
      className={cn(inputClass, "flex items-center justify-between text-left", recording && "ring-2 ring-ring/60")}
      onClick={() => {
        setError(null);
        setRecording((r) => !r);
      }}
      onBlur={() => {
        setRecording(false);
      }}
      onKeyDown={onKey}
    >
      {recording ? (
        <span className="text-xs text-muted-foreground">Press a shortcut… (Esc cancels, ⌫ unbinds)</span>
      ) : (
        <span className={value && value !== "none" ? "" : "text-muted-foreground"}>{displayValue(field, value)}</span>
      )}
    </button>
  );
}

const editors: Record<SettingFieldView["type"], (p: EditorProps) => React.JSX.Element> = {
  bool: BoolEditor,
  enum: EnumEditor,
  int: TextEditor,
  string: TextEditor,
  path: TextEditor,
  keybinding: KeybindingEditor,
};

/** One field: title, description, restart hint, editor, inline error, reset. */
export function SettingRow({ field }: { field: SettingFieldView }) {
  const value = useSettingValue(field.key) ?? field.defaultValue;
  const restartPending = useSettingsStore((s) => s.snapshot?.restartPending.includes(field.key) ?? false);
  const fileIssue = useSettingsStore((s) => s.snapshot?.issues.find((i) => i.key === field.key)?.message);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const commit = (raw: string) => {
    const v = validateSetting(field, raw);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setPending(true);
    void saveSettings({ [field.key]: v.value }).then((res) => {
      setPending(false);
      if (!res.ok) {
        setError(res.issues[field.key] ?? res.error);
        return;
      }
      const shown = displayValue(field, useSettingsStore.getState().snapshot?.values[field.key] ?? v.value);
      toast.success(`Saved ${field.title}`, {
        description: `${shown}${field.restartRequired ? " · applies after a daemon restart" : ""}`,
      });
    });
  };

  const Editor = editors[field.type];
  const modified = value !== field.defaultValue && !(field.type === "keybinding" && value === "" && field.defaultValue === "");
  const message = error ?? (fileIssue ? `In the file: ${fileIssue}` : null);
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_16rem] items-start gap-x-6 gap-y-1 border-b border-border/60 py-3 last:border-b-0"
      data-setting={field.key}
      data-modified={modified || undefined}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium">{field.title}</span>
          {restartPending ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400" data-testid="restart-pending">
              Restart the daemon to apply
            </span>
          ) : (
            field.restartRequired && (
              <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground" data-testid="restart-hint">
                Applies after daemon restart
              </span>
            )
          )}
        </div>
        {field.description && <p className="mt-0.5 text-xs text-muted-foreground">{field.description}</p>}
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">{field.key}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <div className={field.type === "bool" ? "flex flex-1 justify-end" : "min-w-0 flex-1"}>
            <Editor field={field} value={value} pending={pending} invalid={message !== null} commit={commit} setError={setError} />
          </div>
          <button
            type="button"
            title={`Reset to default (${displayValue(field, field.defaultValue)})`}
            aria-label={`Reset ${field.title}`}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", !modified && "invisible")}
            disabled={pending || !modified}
            onClick={() => {
              commit("");
            }}
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>
        {message && (
          <p className="text-xs break-words text-destructive" role="alert" data-testid="setting-error">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
