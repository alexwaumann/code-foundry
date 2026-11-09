/**
 * A list's interactive rows, the row's parts and the add input (docs/notes/plugin-list-rows.md):
 * the checkbox, the grip, the title editor. ListNode puts them together with the state
 * and the drag of listRowsState.ts; rows.ts has the arithmetic.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { GripVertical, Plus } from "lucide-react";
import type { ListAdd, Row } from "@/api/plugin";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { actOnElement } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import type { RowOps } from "./listRowsState";
import { editCommit } from "./rows";

/** A checkable row's checkbox, in the glyph's place; its click is not the row's. */
export function RowCheck({ row, ops, dense }: { row: Row; ops: RowOps; dense: boolean }) {
  return (
    <span className={cn("flex shrink-0 items-center justify-center", dense ? "size-4" : "h-5 w-4")} onClick={(e) => { e.stopPropagation(); }} role="presentation">
      <Checkbox
        checked={row.checked ?? false}
        disabled={ops.inert}
        aria-label={row.title}
        data-testid="plugin-row-check"
        onCheckedChange={(v) => {
          ops.check(row.key, v === true);
        }}
      />
    </span>
  );
}

/** A reorderable row's grip: shown while the row is hovered or has focus; a press starts a drag. */
export function RowGrip({ row, ops, dense }: { row: Row; ops: RowOps; dense: boolean }) {
  return (
    <span
      className={cn(
        "-ml-1 flex w-3.5 shrink-0 cursor-grab touch-none items-center justify-center text-cf-text-muted opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100",
        dense ? "h-4" : "h-5",
        ops.dragging === row.key && "opacity-100",
        ops.inert && "pointer-events-none",
      )}
      aria-hidden
      data-testid="plugin-row-grip"
      onPointerDown={(e) => {
        ops.grab(row.key, e);
      }}
      onClick={(e) => { e.stopPropagation(); }}
    >
      <GripVertical className="size-3.5" />
    </span>
  );
}

/**
 * The title being renamed: Enter or leaving commits (an empty or unchanged title commits
 * nothing), Escape cancels; `done` ends the editing (refocus: Enter and Escape give the
 * focus back to the row).
 */
export function TitleEditor({ title, onCommit, done }: { title: string; onCommit: (text: string) => void; done: (refocus: boolean) => void }) {
  const ended = useRef(false);
  const finish = (commit: boolean, text: string, refocus: boolean) => {
    if (ended.current) return;
    ended.current = true;
    const t = commit ? editCommit(title, text) : null;
    done(refocus);
    if (t !== null) onCommit(t);
  };
  return (
    <Input
      autoFocus
      defaultValue={title}
      maxLength={200}
      aria-label="Title"
      data-testid="plugin-row-edit"
      className="-mx-1 h-6 rounded-sm px-1 text-body-sm"
      onFocus={(e) => {
        e.currentTarget.select();
      }}
      onClick={(e) => { e.stopPropagation(); }}
      onDoubleClick={(e) => { e.stopPropagation(); }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(true, e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false, "", true);
        } else {
          e.stopPropagation();
        }
      }}
      onBlur={(e) => {
        finish(true, e.currentTarget.value, false);
      }}
    />
  );
}

/**
 * A list's add input: Enter sends its trimmed text as an add act on the list (`listKey`)
 * and clears it once the plugin takes it (unless the user typed on meanwhile); the text
 * stays when the plugin refuses it (toasted). Empty text sends nothing; one add at a time.
 * Escape leaves the input.
 */
export function AddRowInput({ listKey, add }: { listKey: string; add: ListAdd }) {
  const { watchKey, inert } = useViewCtx();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const sent = text;
    const t = sent.trim();
    if (t === "" || busy || inert) return;
    setBusy(true);
    void actOnElement(watchKey, listKey, { action: "add", value: t }).then((took) => {
      setBusy(false);
      if (took) setText((cur) => (cur === sent ? "" : cur));
    });
  };
  return (
    <div className="relative flex min-w-0 items-center" data-testid="plugin-list-add">
      <Plus className="pointer-events-none absolute left-2 size-3.5 text-cf-text-muted" aria-hidden />
      <Input
        value={text}
        placeholder={add.placeholder}
        maxLength={200}
        disabled={inert}
        aria-label={add.placeholder || "Add"}
        aria-busy={busy || undefined}
        className={cn("h-8 pl-7 text-body-sm", text.trim() !== "" && "pr-14")}
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      {text.trim() !== "" && (
        <Kbd size="sm" className="pointer-events-none absolute right-2">
          ↵ add
        </Kbd>
      )}
    </div>
  );
}
