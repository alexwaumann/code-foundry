import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { ACTION_ICONS } from "@/api/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { draftOf, draftProblem, NEW_ACTION_DRAFT, type ActionDraft } from "@/lib/actions";
import { cn } from "@/lib/utils";
import { deleteAction, saveAction } from "@/stores/actionActions";
import { closeActionEditor, useActionDialogStore, type ActionEditorTarget } from "@/stores/actionDialog";
import { useActionsStore } from "@/stores/actions";
import { useReposStore } from "@/stores/repos";
import { ACTION_ICON, ACTION_ICON_LABEL } from "./actionIcons";

const inputClass =
  "w-full min-w-0 rounded-md border bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 aria-invalid:border-destructive";

/** A setting row's switch (settings/SettingRow.tsx BoolEditor's look). */
function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      data-testid="action-on-create"
      onClick={() => {
        onChange(!on);
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

/** The six icon tiles (T3's look, in a row); one is picked. */
function IconTiles({ value, onChange, disabled }: { value: ActionDraft["icon"]; onChange: (v: ActionDraft["icon"]) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="grid grid-cols-6 gap-2" data-testid="action-icons">
      {ACTION_ICONS.map((name) => {
        const Icon = ACTION_ICON[name];
        const on = name === value;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            data-icon={name}
            data-testid="action-icon"
            onClick={() => {
              onChange(name);
            }}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-md border px-1 pt-2 pb-1.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              on
                ? "border-primary/70 bg-primary/10 text-foreground dark:border-transparent dark:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_30%,transparent)]"
                : "border-border/70 text-muted-foreground hover:bg-accent/50 hover:text-foreground dark:border-transparent dark:bg-white/[0.035]",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {ACTION_ICON_LABEL[name]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The editor's form for one target: Name, Command (mono), Icon, "Run automatically when a
 * worktree is created", and Cancel / Save; editing adds Delete on the left, which swaps the
 * footer for an inline confirm ("Delete X for every thread in <project>?" Keep / Delete,
 * the armed Delete on the right where Save was, so a double click on the left cannot
 * confirm it). Save and Delete go through action.add / action.edit / action.remove; the
 * daemon's refusal shows above the footer and the form stays as it was.
 */
function ActionForm({ target, keysRef }: { target: ActionEditorTarget; keysRef: RefObject<((e: KeyboardEvent) => void) | null> }) {
  const project = useReposStore((s) => s.byId[target.repoId]?.name ?? target.repoId);
  const existing = useActionsStore((s) => (target.mode === "edit" ? s.byId[target.actionId] : undefined));
  const [draft, setDraft] = useState<ActionDraft>(() => (existing ? draftOf(existing) : NEW_ACTION_DRAFT));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A Delete in flight: the action's removal event usually comes before action.remove
  // answers, and must not read as "deleted meanwhile" for the moment the dialog stays.
  const [removing, setRemoving] = useState(false);
  // Delete and Keep swap the footer, which drops the focused button: the keyboard moves to
  // Keep when the confirm opens and back to Delete when Keep closes it.
  const deleteRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const swapped = useRef(false);
  useEffect(() => {
    if (!swapped.current) return;
    swapped.current = false;
    (confirming ? keepRef : deleteRef).current?.focus();
  }, [confirming]);
  const problem = draftProblem(draft);
  const gone = target.mode === "edit" && !existing && !removing;
  const nameError = error !== null && /\bname/i.test(error);
  const commandError = error !== null && !nameError && /\bcommand/i.test(error);

  // An edit makes the last refusal stale (it was about the draft as it was): the line and
  // the field's red state go until the next Save.
  const set = <K extends keyof ActionDraft>(k: K, v: ActionDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setError(null);
  };

  const save = async () => {
    if (problem !== null || busy || gone) return;
    setBusy(true);
    setError(null);
    const err = await saveAction(target.mode === "edit" ? { repoId: target.repoId, actionId: target.actionId } : { repoId: target.repoId }, draft);
    setBusy(false);
    if (err === null) closeActionEditor();
    else setError(err);
  };

  const remove = async () => {
    if (target.mode !== "edit" || busy) return;
    setBusy(true);
    setRemoving(true);
    setError(null);
    const err = await deleteAction(target.actionId, target.repoId);
    setBusy(false);
    if (err === null) closeActionEditor();
    else {
      setRemoving(false);
      setConfirming(false);
      setError(err);
    }
  };

  // Cmd+Enter saves from anywhere in the dialog (Enter is a newline in the command). The
  // dialog's content handles the key, not the form: WebKit does not focus a button on click,
  // so after clicking an icon tile or the switch the keyboard is on the content itself.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !confirming) {
      e.preventDefault();
      void save();
    }
  };
  useEffect(() => {
    keysRef.current = onKeyDown;
    return () => {
      keysRef.current = null;
    };
  });

  const where = target.from === "projects" ? "the worktree's checkout" : "the thread's checkout";
  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <DialogDescription className="mt-1 pr-7 text-xs text-muted-foreground">
        Saved for every thread in <span className="font-medium text-foreground">{project}</span>. Runs in {where} and opens as a tab in the bottom panel.
      </DialogDescription>
      <div className="mt-4 flex flex-col gap-3.5">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Name</span>
          <input
            value={draft.name}
            onChange={(e) => {
              set("name", e.target.value);
            }}
            disabled={busy}
            placeholder="Test"
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={nameError || undefined}
            data-testid="action-name"
            className={cn(inputClass, "h-8")}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Command</span>
          <textarea
            value={draft.command}
            onChange={(e) => {
              set("command", e.target.value);
            }}
            disabled={busy}
            rows={3}
            placeholder="go test ./..."
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-invalid={commandError || undefined}
            aria-describedby="action-command-help"
            data-testid="action-command"
            className={cn(inputClass, "min-h-[72px] resize-y py-1.5 font-mono text-[12.5px] leading-[19px] whitespace-pre")}
          />
          <span id="action-command-help" className="text-xs text-muted-foreground">
            Runs from the checkout's root. Each line runs in order.
          </span>
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" id="action-icon-label">
            Icon
          </span>
          <IconTiles
            value={draft.icon}
            disabled={busy}
            onChange={(v) => {
              set("icon", v);
            }}
          />
        </div>
        <div className="flex items-center gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
          <span className="min-w-0 flex-1">
            Run automatically when a worktree is created
            <small className="mt-px block text-xs text-muted-foreground">In the background, for a new thread's worktree; failures notify you</small>
          </span>
          <Switch
            on={draft.onWorktreeCreate}
            disabled={busy}
            label="Run automatically when a worktree is created"
            onChange={(v) => {
              set("onWorktreeCreate", v);
            }}
          />
        </div>
      </div>
      {(error !== null || gone) && (
        <p className="mt-3 text-xs text-destructive" role="alert" data-testid="action-error">
          {gone ? "This action was deleted." : error}
        </p>
      )}
      {confirming ? (
        <div className="mt-4 flex items-center gap-2" data-testid="action-delete-confirm">
          <p className="min-w-0 flex-1 text-sm">
            {/* The project's name does not break (at its hyphens, say); a long one ellipsizes. */}
            Delete <span className="font-medium">{existing?.name ?? draft.name}</span> for every thread in{" "}
            <span className="inline-block max-w-full truncate align-bottom" data-testid="action-delete-project">
              {project}
            </span>
            ?
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="action-delete-keep"
            ref={keepRef}
            onClick={() => {
              swapped.current = true;
              setConfirming(false);
            }}
          >
            Keep
          </Button>
          <Button type="button" size="sm" variant="destructive" disabled={busy} data-testid="action-delete-yes" onClick={() => void remove()}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Delete
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          {target.mode === "edit" && !gone && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              className="-ml-1.5 text-destructive hover:text-destructive"
              data-testid="action-delete"
              ref={deleteRef}
              onClick={() => {
                setError(null);
                swapped.current = true;
                setConfirming(true);
              }}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <DialogClose asChild>
            <Button type="button" size="sm" variant="outline" disabled={busy} data-testid="action-cancel">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" size="sm" disabled={problem !== null || busy || gone} title={problem ?? undefined} data-testid="action-save">
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            Save
          </Button>
        </div>
      )}
    </form>
  );
}

/** The action editor: New action (a header menu, a Projects row or project menu) or Edit action (a pencil). */
export function ActionDialog() {
  const target = useActionDialogStore((s) => s.editor);
  const seq = useActionDialogStore((s) => s.seq);
  // The form's Cmd+Enter, handled on the whole content (see ActionForm).
  const keys = useRef<((e: KeyboardEvent) => void) | null>(null);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) closeActionEditor();
      }}
    >
      <DialogContent
        className="max-w-lg p-4"
        data-testid="action-dialog"
        data-mode={target?.mode}
        onKeyDown={(e) => {
          keys.current?.(e);
        }}
      >
        <DialogTitle>{target?.mode === "edit" ? "Edit action" : "New action"}</DialogTitle>
        {target !== null && <ActionForm key={seq} target={target} keysRef={keys} />}
        {/* After the form, so the dialog's first focus lands on Name. */}
        <DialogClose
          className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="Close"
          data-testid="action-dialog-close"
        >
          <X className="size-4" aria-hidden />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
