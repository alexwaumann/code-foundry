import { useEffect, useRef } from "react";
import { FolderPlus, Layers, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { folderChoiceHeading, projectChoiceLine, workspaceChoiceLine } from "@/lib/folderChoice";
import { homeDisplay, HOME_PREFIX } from "@/palette/paths";

export type FolderChoiceBusy = "workspace" | "project" | null;

/**
 * The Local folder tab's two choices for a folder that is not a git repository but has git
 * repositories directly inside it (docs/notes/workspaces-v2-6-scan.md): Add as workspace
 * (focused, the default) or Add as project (a plain folder, as before). Each button has one
 * explanatory line beside it; the labels stay short.
 */
export function FolderChoice({
  path,
  repos,
  busy,
  error,
  onWorkspace,
  onProject,
}: {
  /** The folder as typed ("~/product/"). */
  path: string;
  repos: number;
  busy: FolderChoiceBusy;
  error: string | null;
  onWorkspace: () => void;
  onProject: () => void;
}) {
  const workspaceRef = useRef<HTMLButtonElement>(null);
  // Focus the default when the choice appears (the path input had it).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      workspaceRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [path]);

  const shown = `${HOME_PREFIX}${homeDisplay(path).replace(/\/+$/, "")}`;
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={`How to add ${shown}`} data-testid="add-project-choice" data-repos={repos}>
      <p className="text-body-sm text-cf-text-muted" data-testid="add-project-choice-heading">
        <span className="font-mono text-cf-text">{shown}</span> {folderChoiceHeading(repos)}
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        <Button ref={workspaceRef} type="button" size="sm" disabled={busy !== null} onClick={onWorkspace} data-testid="add-project-as-workspace">
          {busy === "workspace" ? <Loader2 className="animate-spin" aria-hidden /> : <Layers aria-hidden />}
          Add as workspace
        </Button>
        <span className="text-caption text-cf-text-muted" data-testid="add-project-as-workspace-line">
          {workspaceChoiceLine(repos)}
        </span>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={onProject} data-testid="add-project-as-project">
          {busy === "project" ? <Loader2 className="animate-spin" aria-hidden /> : <FolderPlus aria-hidden />}
          Add as project
        </Button>
        <span className="text-caption text-cf-text-muted" data-testid="add-project-as-project-line">
          {projectChoiceLine}
        </span>
      </div>
      {error && (
        <p className="text-caption whitespace-pre-wrap text-cf-error-text" role="alert" data-testid="add-project-choice-error">
          {error}
        </p>
      )}
    </div>
  );
}
