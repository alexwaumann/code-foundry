import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Loader2, Trash2, X } from "lucide-react";
import { ACTION_ICONS } from "@/api/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import { draftOf, draftProblem, NEW_ACTION_DRAFT, type ActionDraft } from "@/lib/actions";
import { deleteAction, saveAction } from "@/stores/actionActions";
import { closeActionEditor, useActionDialogStore, type ActionEditorTarget } from "@/stores/actionDialog";
import { useActionsStore } from "@/stores/actions";
import { useProjectsStore } from "@/stores/projects";
import { ACTION_ICON, ACTION_ICON_LABEL } from "./actionIcons";

/** The six icon tiles (T3's look, in a row); one is picked, one tab stop, arrows move it. */
function IconTiles({ value, onChange, disabled }: { value: ActionDraft["icon"]; onChange: (v: ActionDraft["icon"]) => void; disabled?: boolean }) {
  return (
    <RadioGroup
      aria-label="Icon"
      className="grid-cols-6 gap-2"
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        const icon = ACTION_ICONS.find((n) => n === v);
        if (icon) onChange(icon);
      }}
      data-testid="action-icons"
    >
      {ACTION_ICONS.map((name) => {
        const Icon = ACTION_ICON[name];
        return (
          <RadioGroupChoice key={name} value={name} variant="tile" data-icon={name} data-testid="action-icon">
            <Icon aria-hidden />
            {ACTION_ICON_LABEL[name]}
          </RadioGroupChoice>
        );
      })}
    </RadioGroup>
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
  const project = useProjectsStore((s) => s.byId[target.projectId]?.name ?? target.projectId);
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
    const err = await saveAction(target.mode === "edit" ? { projectId: target.projectId, actionId: target.actionId } : { projectId: target.projectId }, draft);
    setBusy(false);
    if (err === null) closeActionEditor();
    else setError(err);
  };

  const remove = async () => {
    if (target.mode !== "edit" || busy) return;
    setBusy(true);
    setRemoving(true);
    setError(null);
    const err = await deleteAction(target.actionId, target.projectId);
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
      <DialogDescription className="mt-1 pr-7 text-caption">
        Saved for every thread in <span className="font-medium text-cf-text">{project}</span>. Runs in {where} and opens as a tab in the bottom panel.
      </DialogDescription>
      <div className="mt-4 flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="action-name" className="text-label">
            Name
          </Label>
          <Input
            id="action-name"
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
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="action-command" className="text-label">
            Command
          </Label>
          <Textarea
            id="action-command"
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
            className="min-h-[72px] resize-y py-1.5 text-body-sm font-mono whitespace-pre"
          />
          <span id="action-command-help" className="text-caption">
            Runs from the checkout's root. Each line runs in order.
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label" id="action-icon-label">
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
        <div className="flex items-center gap-3 rounded-md border border-cf-border/70 px-3 py-2 text-body dark:border-transparent dark:bg-cf-text/[0.035]">
          <span className="min-w-0 flex-1">
            Run automatically when a worktree is created
            <small className="mt-px block text-caption">In the background, for a new thread's worktree; failures notify you</small>
          </span>
          <Switch
            checked={draft.onWorktreeCreate}
            disabled={busy}
            aria-label="Run automatically when a worktree is created"
            data-testid="action-on-create"
            onCheckedChange={(v) => {
              set("onWorktreeCreate", v);
            }}
          />
        </div>
      </div>
      {(error !== null || gone) && (
        <p className="mt-3 text-caption text-cf-error-text" role="alert" data-testid="action-error">
          {gone ? "This action was deleted." : error}
        </p>
      )}
      {confirming ? (
        <div className="mt-4 flex items-center gap-2" data-testid="action-delete-confirm">
          <p className="min-w-0 flex-1 text-body">
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
              className="-ml-1.5 text-cf-error-text hover:text-cf-error-text"
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
          {/* Why Save is disabled; the span takes the hover a disabled button does not get. */}
          <Tip label={problem}>
            <span className="inline-flex">
              <Button type="submit" size="sm" disabled={problem !== null || busy || gone} data-testid="action-save">
                {busy && <Loader2 className="animate-spin" aria-hidden />}
                Save
              </Button>
            </span>
          </Tip>
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
          className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50"
          aria-label="Close"
          data-testid="action-dialog-close"
        >
          <X className="size-4" aria-hidden />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
