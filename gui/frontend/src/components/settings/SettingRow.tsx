import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingFieldView } from "@/api/settings";
import { Tip } from "@/components/ui/tooltip";
import { Highlight } from "./Highlight";
import { keyEditors, tallKeyEditors } from "./keyEditors";
import { displayValue } from "./model";
import { useSettingField } from "./useSettingField";


type FieldState = ReturnType<typeof useSettingField>;

/** "Applies after daemon restart", or "Restart the daemon to apply" once changed. */
export function RestartChip({ field, restartPending }: { field: SettingFieldView; restartPending: boolean }) {
  if (restartPending)
    return (
      <span className="rounded-sm bg-warning/15 px-1.5 py-px text-caption-sm font-medium text-warning" data-testid="restart-pending">
        Restart the daemon to apply
      </span>
    );
  if (!field.restartRequired) return null;
  return (
    <span className="rounded-sm bg-muted px-1.5 py-px text-caption-sm" data-testid="restart-hint">
      Applies after daemon restart
    </span>
  );
}

/** The reset arrow; its slot is kept while hidden, so editors stay aligned. */
export function ResetButton({ field, state }: { field: SettingFieldView; state: FieldState }) {
  const { modified, pending, commit } = state;
  return (
    <Tip label={`Reset to default (${displayValue(field, field.defaultValue)})`}>
      <button
        type="button"
        aria-label={`Reset ${field.title}`}
        className={cn("shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground", !modified && "invisible")}
        disabled={pending || !modified}
        onClick={() => {
          commit("");
        }}
      >
        <RotateCcw className="size-3.5" />
      </button>
    </Tip>
  );
}

export function FieldError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p className={cn("text-caption break-words text-destructive", className)} role="alert" data-testid="setting-error">
      {message}
    </p>
  );
}

/** The editor and its reset arrow; a switch or a number input sits at the right end. */
function EditorCell({ field, state }: { field: SettingFieldView; state: FieldState }) {
  const right = field.type === "bool" || (field.type === "int" && !keyEditors[field.key]);
  const tall = tallKeyEditors.has(field.key);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cn("flex gap-1.5", tall ? "items-start" : "items-center")}>
        <div className={right ? "flex min-w-0 flex-1 justify-end" : "min-w-0 flex-1"}>{state.editor}</div>
        {/* Beside the first control (h-8) rather than the middle of a tall editor. */}
        <div className={cn("flex", tall && "mt-[5px]")}>
          <ResetButton field={field} state={state} />
        </div>
      </div>
      <FieldError message={state.message} />
    </div>
  );
}

export interface SettingRowProps {
  field: SettingFieldView;
  className?: string;
  /** Above the title: where the field lives ("Appearance › Terminal"), in search results. */
  crumb?: ReactNode;
  /** Search words: highlighted in the title and description, and the key is shown with them. */
  words?: readonly string[];
  /** Indented under its parent toggle (the row above), with a hairline. */
  indent?: boolean;
  /** The parent toggle is off: the row dims (its editor still works). */
  dimmed?: boolean;
  /** Under the description while dimmed: why the row has no effect now. */
  note?: string;
}

/** One field in a section card: title, description, restart hint, editor, inline error, reset. */
export function SettingRow({ field, className, crumb, words, indent = false, dimmed = false, note }: SettingRowProps) {
  const state = useSettingField(field);
  return (
    <div
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_18rem] gap-x-6 gap-y-1 px-4 py-3",
        tallKeyEditors.has(field.key) ? "items-start" : "items-center",
        // The hairline from the parent row down to this one, ending in a short elbow.
        indent &&
          "pl-10 before:absolute before:top-0 before:bottom-4 before:left-5 before:w-px before:bg-border after:absolute after:bottom-4 after:left-5 after:h-px after:w-2 after:bg-border",
        className,
      )}
      data-setting={field.key}
      data-modified={state.modified || undefined}
      data-dimmed={dimmed || undefined}
    >
      <div className={cn("min-w-0", dimmed && "opacity-45")}>
        {crumb}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-label">
            <Highlight text={field.title} words={words} />
          </span>
          <RestartChip field={field} restartPending={state.restartPending} />
        </div>
        {field.description && (
          <p className="mt-0.5 text-caption">
            <Highlight text={field.description} words={words} />
          </p>
        )}
        {dimmed && note && <p className="mt-0.5 text-caption-sm">{note}</p>}
        {words && words.length > 0 && (
          <p className="mt-0.5 text-caption-sm font-mono text-muted-foreground/75" data-testid="setting-key">
            <Highlight text={field.key} words={words} />
          </p>
        )}
      </div>
      <div className={cn(dimmed && "opacity-45 focus-within:opacity-100 hover:opacity-100")}>
        <EditorCell field={field} state={state} />
      </div>
    </div>
  );
}

/** One of a pair's fields: its title above its editor. */
function PairCell({ field }: { field: SettingFieldView }) {
  const state = useSettingField(field);
  return (
    <div className="min-w-0" data-setting={field.key} data-modified={state.modified || undefined}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-label">{field.title}</span>
        <RestartChip field={field} restartPending={state.restartPending} />
      </div>
      <EditorCell field={field} state={state} />
    </div>
  );
}

/**
 * Fields sharing a row (threads.default_model and default_effort): side by side, each
 * title above its editor, and the first field's description under the pair.
 */
export function SettingRowPair({ fields, className }: { fields: readonly SettingFieldView[]; className?: string }) {
  const description = fields[0]?.description;
  return (
    <div className={cn("px-4 py-3", className)} data-setting-row={fields[0]?.row}>
      <div className="grid grid-flow-col auto-cols-fr gap-x-6">
        {fields.map((f) => (
          <PairCell key={f.key} field={f} />
        ))}
      </div>
      {description && <p className="mt-2 text-caption">{description}</p>}
    </div>
  );
}
