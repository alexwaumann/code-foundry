import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileText, Folder, Sparkles } from "lucide-react";
import { FinderMark } from "@/components/icons/FinderMark";
import { Tip } from "@/components/ui/tooltip";
import { tildify } from "@/lib/path";
import { threadLabel } from "@/lib/prompt";
import { instructionsName, instructionsThread } from "@/lib/workspaceCard";
import { useThreadsStore } from "@/stores/threads";
import { openSettingsPage } from "@/stores/views";
import { editWorkspaceInstructions, openWorkspaceInstructions, revealWorkspace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { LinkButton, SectionHeader } from "./bits";

function InfoRow({ icon, label, children, testId, data }: { icon: React.ReactNode; label: string; children: React.ReactNode; testId: string; data?: Record<string, string | undefined> }) {
  return (
    <div className="flex min-h-10 items-center gap-4 border-b border-cf-divider py-1.5 last:border-b-0" data-testid={testId} {...data}>
      <span className="flex w-30 shrink-0 items-center gap-1.5 text-caption text-cf-text-muted [&_svg]:size-3.5">
        {icon}
        <span className="truncate" data-testid={`${testId}-label`}>
          {label}
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-body-sm text-cf-text-secondary">{children}</span>
    </div>
  );
}

const Dot = () => <span aria-hidden>·</span>;

/**
 * Who "Write instructions" / "Edit instructions" reaches (lib/workspaceCard.ts
 * instructionsThread): "starts a thread", or the thread already in the workspace's folder
 * it steers.
 */
function useInstructionsReach(workspaceId: string): string {
  const rootPath = useWorkspacesStore((s) => s.byId[workspaceId]?.rootPath ?? "");
  const managedDir = useWorkspacesStore((s) => s.byId[workspaceId]?.managedDir ?? "");
  return useThreadsStore((s) => {
    const id = instructionsThread(s, { id: workspaceId, rootPath, managedDir });
    return id === null ? "starts a thread" : `sends to ${threadLabel(s.byId[id]?.name ?? "", id)}`;
  });
}

/**
 * The instructions file: "None yet · Write instructions (starts a thread)", or its path
 * with View (a File tab in the page's panel) and Edit instructions. Both steer the thread
 * already in the workspace's folder, else start one there (stores/workspaceActions.ts).
 */
function InstructionsRow({ workspaceId }: { workspaceId: string }) {
  const file = useWorkspacesStore((s) => s.byId[workspaceId]?.instructions ?? "");
  const reach = useInstructionsReach(workspaceId);
  const [busy, setBusy] = useState(false);
  const edit = () => {
    setBusy(true);
    void editWorkspaceInstructions(workspaceId).finally(() => {
      setBusy(false);
    });
  };
  const action = file ? "Edit instructions" : "Write instructions";
  return (
    <InfoRow icon={<FileText aria-hidden />} label={instructionsName({ instructions: file }) || "CLAUDE.md"} testId="workspace-instructions" data={{ "data-file": file || undefined }}>
      {file ? (
        <>
          <Tip label={file} whenTruncated>
            <span className="min-w-0 truncate font-mono text-code" data-testid="workspace-instructions-path">
              {tildify(file)}
            </span>
          </Tip>
          <Dot />
          <LinkButton testId="workspace-instructions-open" onClick={() => openWorkspaceInstructions(workspaceId)}>
            View
          </LinkButton>
          <Dot />
        </>
      ) : (
        <>
          <span data-testid="workspace-instructions-none">None yet</span>
          <Dot />
        </>
      )}
      <LinkButton testId="workspace-edit-instructions" className={busy ? "pointer-events-none opacity-60" : undefined} onClick={edit}>
        {busy ? (reach === "starts a thread" ? "Starting…" : "Sending…") : action}
      </LinkButton>
      <span className="text-cf-text-muted" data-testid="workspace-instructions-reach">
        ({reach})
      </span>
    </InfoRow>
  );
}

/** The skills in the workspace's .claude/skills by name (or "None yet") · Browse marketplace (Settings → Skills). */
function SkillsRow({ workspaceId }: { workspaceId: string }) {
  const skills = useWorkspacesStore(useShallow((s) => [...(s.byId[workspaceId]?.skills ?? [])]));
  const list = skills.join(", ");
  return (
    <InfoRow icon={<Sparkles aria-hidden />} label="Skills" testId="workspace-skills">
      {skills.length === 0 ? (
        <span data-testid="workspace-skills-none">None yet</span>
      ) : (
        <Tip label={list} whenTruncated>
          <span className="max-w-[40rem] min-w-0 truncate" data-testid="workspace-skills-list">
            {list}
          </span>
        </Tip>
      )}
      <Dot />
      <LinkButton testId="workspace-browse-skills" onClick={() => { openSettingsPage("skills"); }}>
        Browse marketplace
      </LinkButton>
    </InfoRow>
  );
}

/** Where the instructions and skills live: the folder the app keeps (synthetic) or the workspace's root · Open in Finder. */
function FolderInfoRow({ workspaceId }: { workspaceId: string }) {
  const root = useWorkspacesStore((s) => s.byId[workspaceId]?.rootPath ?? "");
  const managed = useWorkspacesStore((s) => s.byId[workspaceId]?.managedDir ?? "");
  const dir = root || managed;
  return (
    <InfoRow icon={<Folder aria-hidden />} label="Folder" testId="workspace-folder-info">
      {dir && (
        <>
          <Tip label={dir} whenTruncated>
            <span className="min-w-0 truncate" data-testid="workspace-folder-path">
              {tildify(dir)}
            </span>
          </Tip>
          <Dot />
        </>
      )}
      <span data-testid="workspace-folder-kind">{root ? "its root" : "kept by the app"}</span>
      <Dot />
      <LinkButton testId="workspace-folder-reveal" onClick={() => void revealWorkspace(workspaceId)}>
        <FinderMark />
        Open in Finder
      </LinkButton>
    </InfoRow>
  );
}

/** Instructions and skills: what every thread in the workspace gets (the daemon appends the instructions; the skills folder is an --add-dir). */
export function WorkspaceInstructions({ workspaceId }: { workspaceId: string }) {
  return (
    <div data-testid="workspace-contents">
      <SectionHeader label="Instructions and skills" detail="added to every thread in this workspace" testId="workspace-contents-title" />
      <div className="rounded-lg border bg-cf-surface px-3.5">
        <InstructionsRow workspaceId={workspaceId} />
        <SkillsRow workspaceId={workspaceId} />
        <FolderInfoRow workspaceId={workspaceId} />
      </div>
    </div>
  );
}
