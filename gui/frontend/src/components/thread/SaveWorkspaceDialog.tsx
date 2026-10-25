import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { closeSaveWorkspace, saveThreadAsWorkspace, useSaveWorkspaceStore } from "@/stores/saveWorkspace";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

/** The dialog's body for one thread: the name, the projects it saves, Cancel and Save. */
function SaveBody({ threadId }: { threadId: string }) {
  const ids = useThreadsStore(useShallow((s) => s.byId[threadId]?.projectIds ?? []));
  const names = useProjectsStore(useShallow((s) => ids.map((id) => s.byId[id]?.name ?? id)));
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ready = name.trim() !== "" && !saving;
  const submit = async () => {
    if (!ready) return;
    setSaving(true);
    const failed = await saveThreadAsWorkspace(threadId, name);
    setSaving(false);
    if (failed) setError(failed);
    else closeSaveWorkspace();
  };
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        value={name}
        placeholder="Workspace name"
        aria-label="Workspace name"
        maxLength={100}
        data-testid="save-workspace-name"
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
      />
      <p className="text-caption text-cf-text-muted" data-testid="save-workspace-projects">
        {names.join(", ")}
      </p>
      {error && (
        <p role="alert" className="text-body-sm text-cf-error-text" data-testid="save-workspace-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={closeSaveWorkspace}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready} data-testid="save-workspace-submit">
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * "Save as workspace" from the thread header's menu (stores/saveWorkspace.ts): names the
 * thread's set; saving makes the workspace (the thread's primary its default) and the
 * thread's reference.
 */
export function SaveWorkspaceDialog() {
  const open = useSaveWorkspaceStore((s) => s.open);
  const threadId = useSaveWorkspaceStore((s) => s.threadId);
  const seq = useSaveWorkspaceStore((s) => s.seq);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSaveWorkspace();
      }}
    >
      <DialogContent className="max-w-sm p-4" data-testid="save-workspace-dialog" data-thread={threadId}>
        <div className="flex items-center gap-2">
          <Layers className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
          <DialogTitle>Save as workspace</DialogTitle>
        </div>
        <DialogDescription>New threads can start in these projects together, with instructions and skills that span them.</DialogDescription>
        {open && <SaveBody key={seq} threadId={threadId} />}
      </DialogContent>
    </Dialog>
  );
}
