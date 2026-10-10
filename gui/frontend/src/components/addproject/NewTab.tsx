import { useCallback, useEffect, useRef, useState } from "react";
import { CloudUpload, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/stream";
import { PublishPicker } from "@/components/publish/PublishPicker";
import { usePublishOwners, type PublishChoice } from "@/components/publish/usePublishOwners";
import { Button } from "@/components/ui/button";
import { tildify } from "@/lib/path";
import { projectNameError, projectsDirFrom } from "@/lib/publish";
import { closeAddProject, selectAddedProject } from "@/stores/addProject";
import { createProject, publishProject, type CreatedProject } from "@/stores/publish";
import { useSettingsStore } from "@/stores/settings";

/**
 * New: a name (checked as it is typed, with the folder it becomes), an optional Publish
 * to GitHub step (owner and visibility), and Create. Create runs repo.create, then
 * repo.github.publish when asked. A refused publish keeps the project (it exists
 * locally) and the picker, with gh's error under it, so another owner or visibility can
 * be tried, or the project kept local.
 */
export function NewTab({ active }: { active: boolean }) {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [publish, setPublish] = useState(false);
  const [choice, setChoice] = useState<PublishChoice>({ owner: "", visibility: null });
  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [busy, setBusy] = useState<"create" | "publish" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectsDir = useSettingsStore((s) => projectsDirFrom(s.snapshot?.path));
  const owners = usePublishOwners(
    publish,
    useCallback((first: PublishChoice) => {
      setChoice((cur) => (cur.owner ? cur : first));
    }, []),
  );

  // Focus the name when the tab is shown (a click on the tab focuses the tab first).
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [active]);

  const nameError = projectNameError(name);
  const destination = `${tildify(projectsDir)}/${name || "<name>"}`;
  const canPublish = !publish || (choice.owner !== "" && choice.visibility !== null);

  const finish = (project: CreatedProject, message: string) => {
    toast.success(message);
    closeAddProject();
    selectAddedProject(project.id);
  };

  const submit = async () => {
    setTouched(true);
    if (busy || (!created && nameError) || !canPublish) return;
    let project = created;
    if (!project) {
      setBusy("create");
      setCreateError(null);
      try {
        project = await createProject(name);
        setCreated(project);
      } catch (err) {
        setCreateError(errorMessage(err));
        setBusy(null);
        return;
      }
    }
    if (!publish || !choice.visibility) {
      finish(project, `Created ${project.name}`);
      return;
    }
    setBusy("publish");
    setPublishError(null);
    try {
      await publishProject({ repoId: project.id, owner: choice.owner, name: project.name, visibility: choice.visibility });
      finish(project, `Created ${project.name} and published it to ${choice.owner}/${project.name}`);
    } catch (err) {
      setPublishError(errorMessage(err));
      setBusy(null);
    }
  };

  const nameMessage = createError ?? (touched || name !== "" ? nameError : null);
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="add-project-new"
      data-created={created?.id ?? ""}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-xs text-muted-foreground">An empty project with git initialized (an empty first commit on the default branch).</p>
      <div className="flex flex-col gap-1.5">
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setCreateError(null);
          }}
          disabled={created !== null || busy !== null}
          placeholder="Project name"
          aria-label="Project name"
          aria-invalid={nameMessage ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          className="h-9 rounded-md border bg-transparent px-3 font-mono text-sm outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60 aria-invalid:border-destructive"
          data-testid="add-project-new-name"
        />
        <span className="truncate text-xs text-muted-foreground">
          Creates <span className="font-mono text-foreground" data-testid="add-project-new-dest">{destination}</span>
        </span>
        {nameMessage && (
          <span className="text-xs whitespace-pre-wrap text-destructive" role="alert" data-testid="add-project-new-error">
            {nameMessage}
          </span>
        )}
        {created && (
          <span className="text-xs text-emerald-400" data-testid="add-project-new-created">
            Created {created.name}. It stays a local project until it is published.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
        <label className="flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={publish}
            disabled={busy !== null}
            onChange={(e) => {
              setPublish(e.target.checked);
              setPublishError(null);
            }}
            className="size-3.5 accent-primary"
            data-testid="add-project-new-publish"
          />
          <CloudUpload className="size-4 text-muted-foreground" aria-hidden />
          Publish to GitHub
        </label>
        {publish && <PublishPicker owners={owners} value={choice} onChange={setChoice} disabled={busy !== null} error={publishError} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        {created && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              finish(created, `Created ${created.name}`);
            }}
            data-testid="add-project-keep-local"
          >
            Keep it local
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy !== null || (!created && name === "") || !canPublish} data-testid="add-project-create">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : publish ? <CloudUpload aria-hidden /> : <Sparkles aria-hidden />}
          {busy === "create"
            ? "Creating…"
            : busy === "publish"
              ? "Publishing…"
              : created
                ? publish
                  ? "Publish"
                  : "Done"
                : publish
                  ? "Create and publish"
                  : "Create project"}
        </Button>
      </div>
    </form>
  );
}
