import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { workspaceNameError } from "@/lib/workspaceCard";
import { useProjectsStore } from "@/stores/projects";
import { closeNewWorkspaceDialog, createWorkspace, useNewWorkspaceDialogStore } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";

/** One registered project as a checkbox row. */
function ProjectOption({ projectId, checked, disabled, onChange }: { projectId: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const id = useId();
  return (
    <div className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-cf-control-hover" data-testid="new-workspace-project" data-project={projectId}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => {
          onChange(v === true);
        }}
      />
      <Label htmlFor={id} className="min-w-0 flex-1 truncate text-body">
        {name}
      </Label>
    </div>
  );
}

/** The dialog's body: a name and the projects (at least one), then workspace.new. A refusal shows the daemon's words. */
function NewWorkspaceBody() {
  const projects = useProjectsStore(useShallow((s) => [...s.order]));
  const names = useWorkspacesStore(useShallow((s) => s.order.map((id) => s.byId[id]?.name ?? "")));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameId = useId();
  const nameError = name.trim() === "" ? "" : workspaceNameError(name, names);
  const ready = name.trim() !== "" && !nameError && picked.length > 0 && !busy;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError("");
    // In the page order (by name): the daemon makes the first one given the default primary.
    const err = await createWorkspace(name, projects.filter((p) => picked.includes(p)));
    if (err) {
      setError(err === "cancelled" ? "" : err);
      setBusy(false);
      return;
    }
    closeNewWorkspaceDialog();
  };
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-caption">A saved set of projects to start threads in together, with a place for the instructions and skills that span them. Nothing on disk changes.</p>
      <div className="flex items-center gap-2">
        <Label htmlFor={nameId} className="w-16 text-caption text-cf-text-muted">
          Name
        </Label>
        <Input
          id={nameId}
          autoFocus
          value={name}
          disabled={busy}
          placeholder="shop"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={nameError ? true : undefined}
          className="flex-1"
          data-testid="new-workspace-name"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </div>
      {nameError && (
        <p className="text-caption text-cf-error-text" data-testid="new-workspace-name-error">
          {nameError}
        </p>
      )}
      <div className="flex flex-col gap-1">
        <span className="text-caption text-cf-text-muted">Projects</span>
        {projects.length === 0 ? (
          <p className="text-caption">No projects registered yet: add one first.</p>
        ) : (
          <div className="flex max-h-60 flex-col overflow-y-auto rounded-md border p-1" data-testid="new-workspace-projects">
            {projects.map((p) => (
              <ProjectOption
                key={p}
                projectId={p}
                checked={picked.includes(p)}
                disabled={busy}
                onChange={(on) => {
                  setPicked((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));
                }}
              />
            ))}
          </div>
        )}
      </div>
      {error && (
        <p className="text-caption text-cf-error-text" data-testid="new-workspace-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closeNewWorkspaceDialog}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready} data-testid="new-workspace-submit">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Layers aria-hidden />}
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

/** New workspace (workspace.new's presenter: the Projects page's button and the palette). */
export function NewWorkspaceDialog() {
  const open = useNewWorkspaceDialogStore((s) => s.open);
  const seq = useNewWorkspaceDialogStore((s) => s.seq);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeNewWorkspaceDialog();
      }}
    >
      <DialogContent className="max-w-md p-4" data-testid="new-workspace-dialog">
        <DialogTitle>New workspace</DialogTitle>
        <DialogDescription className="sr-only">Name the workspace and pick its projects.</DialogDescription>
        {open && <NewWorkspaceBody key={seq} />}
      </DialogContent>
    </Dialog>
  );
}
