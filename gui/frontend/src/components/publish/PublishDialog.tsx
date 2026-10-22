import { useCallback, useId, useState } from "react";
import { CloudUpload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/stream";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { projectNameError, type PublishOwnerView } from "@/lib/publish";
import { closePublishDialog, publishProject, usePublishDialogStore } from "@/stores/publish";
import { useProjectsStore } from "@/stores/projects";
import { PublishPicker } from "./PublishPicker";
import { usePublishOwners, type PublishChoice } from "./usePublishOwners";

/**
 * The body of the publish dialog for one project: owner, GitHub name (the project's by
 * default) and visibility, then project.github.publish. A refusal shows gh's error under the
 * picker and keeps everything as it was, so another choice can be tried.
 */
function PublishBody({ projectId }: { projectId: string }) {
  const project = useProjectsStore((s) => s.byId[projectId]?.name ?? "");
  const [name, setName] = useState(project);
  const nameId = useId();
  const [choice, setChoice] = useState<PublishChoice>({ owner: "", visibility: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owners = usePublishOwners(
    true,
    useCallback((first: PublishChoice, list: PublishOwnerView[]) => {
      setChoice((cur) => (cur.owner && list.some((o) => o.login === cur.owner) ? cur : first));
    }, []),
  );
  const nameError = name === "" ? null : projectNameError(name);
  const ready = choice.owner !== "" && choice.visibility !== null && !nameError && !busy;

  const submit = async () => {
    if (!ready || !choice.visibility) return;
    setBusy(true);
    setError(null);
    try {
      const msg = await publishProject({ projectId, owner: choice.owner, name, visibility: choice.visibility });
      toast.success(msg || `Published ${project}`);
      closePublishDialog();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-caption">
        Creates the repository on GitHub with gh, adds it as <span className="font-mono">origin</span> and pushes.
      </p>
      <PublishPicker owners={owners} value={choice} onChange={setChoice} disabled={busy} error={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={nameId} className="w-16 text-caption text-cf-text-muted">
          Name
        </Label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          disabled={busy}
          placeholder={project}
          aria-label="Repository name on GitHub"
          aria-invalid={nameError ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono"
          data-testid="publish-name"
        />
      </div>
      {nameError && (
        <p className="text-caption text-cf-error" data-testid="publish-name-error">
          {nameError}
        </p>
      )}
      {choice.owner && (
        <p className="text-caption">
          As <span className="font-mono text-cf-text" data-testid="publish-slug">{`${choice.owner}/${name || project}`}</span>
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={closePublishDialog}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready} data-testid="publish-submit">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <CloudUpload aria-hidden />}
          {busy ? "Publishing…" : error ? "Try again" : "Publish"}
        </Button>
      </div>
    </form>
  );
}

/** Publish to GitHub (project.github.publish's presenter, and the overview's button). */
export function PublishDialog() {
  const open = usePublishDialogStore((s) => s.open);
  const projectId = usePublishDialogStore((s) => s.projectId);
  const seq = usePublishDialogStore((s) => s.seq);
  const project = useProjectsStore((s) => s.byId[projectId]?.name ?? "");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closePublishDialog();
      }}
    >
      <DialogContent className="max-w-lg p-4" data-testid="publish-dialog" data-project={projectId}>
        <DialogTitle>Publish {project} to GitHub</DialogTitle>
        <DialogDescription className="sr-only">Pick the owner and visibility of the new GitHub repository.</DialogDescription>
        {open && <PublishBody key={seq} projectId={projectId} />}
      </DialogContent>
    </Dialog>
  );
}
