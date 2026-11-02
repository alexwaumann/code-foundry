import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileText, Folder, Sparkles } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { tildify } from "@/lib/path";
import { threadLabel } from "@/lib/prompt";
import { instructionsName, instructionsThread } from "@/lib/workspaceCard";
import { useThreadsStore } from "@/stores/threads";
import { openSettingsPage } from "@/stores/views";
import { editWorkspaceInstructions, openWorkspaceInstructions } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { SectionHeader } from "./bits";
import { CopyPath, DetailButton, DetailRow } from "./DetailRow";
import { workspaceOpenIn } from "./openIn";
import { OpenInSplit } from "./OpenInFinder";
import { useWorkspaceTerminal } from "./workspaceHooks";

/**
 * Who "Write instructions" / "Edit instructions" reaches (lib/workspaceCard.ts
 * instructionsThread): a new thread, or the thread already in the workspace's folder it
 * steers. The button's tooltip says so (it is not on screen).
 */
function useInstructionsReach(workspaceId: string): { steers: boolean; text: string } {
  const rootPath = useWorkspacesStore((s) => s.byId[workspaceId]?.rootPath ?? "");
  const managedDir = useWorkspacesStore((s) => s.byId[workspaceId]?.managedDir ?? "");
  const text = useThreadsStore((s) => {
    const id = instructionsThread(s, { id: workspaceId, rootPath, managedDir });
    return id === null ? "" : `Sends to ${threadLabel(s.byId[id]?.name ?? "", id)}`;
  });
  return text ? { steers: true, text } : { steers: false, text: "Starts a thread" };
}

/**
 * The instructions file: its path (or "None yet") | View (a File tab in the page's panel) and
 * Edit instructions (Write instructions without one), whose tooltip says whom it reaches. Both
 * steer the thread already in the workspace's folder, else start one there
 * (stores/workspaceActions.ts).
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
    <DetailRow
      icon={<FileText aria-hidden />}
      label={instructionsName({ instructions: file }) || "CLAUDE.md"}
      testId="workspace-instructions"
      data={{ "data-file": file || undefined }}
      value={file ? tildify(file) : "None yet"}
      full={file || undefined}
      valueTestId={file ? "workspace-instructions-path" : "workspace-instructions-none"}
      right={
        <>
          {file && (
            <DetailButton testId="workspace-instructions-open" onClick={() => openWorkspaceInstructions(workspaceId)}>
              View
            </DetailButton>
          )}
          <Tip label={reach.text}>
            <DetailButton testId="workspace-edit-instructions" busy={busy} data-reach={reach.text} onClick={edit}>
              {busy ? (reach.steers ? "Sending…" : "Starting…") : action}
            </DetailButton>
          </Tip>
        </>
      }
    />
  );
}

/** The skills in the workspace's .claude/skills by name (or "None yet") | Browse marketplace (Settings → Skills). */
function SkillsRow({ workspaceId }: { workspaceId: string }) {
  const skills = useWorkspacesStore(useShallow((s) => [...(s.byId[workspaceId]?.skills ?? [])]));
  return (
    <DetailRow
      icon={<Sparkles aria-hidden />}
      label="Skills"
      testId="workspace-skills"
      value={skills.length === 0 ? "None yet" : skills.join(", ")}
      valueTestId={skills.length === 0 ? "workspace-skills-none" : "workspace-skills-list"}
      right={
        <DetailButton testId="workspace-browse-skills" onClick={() => { openSettingsPage("skills"); }}>
          Browse marketplace
        </DetailButton>
      }
    />
  );
}

/**
 * Where the instructions and skills live: the folder the app keeps (synthetic) or the
 * workspace's root | Copy path and Open in Finder with its Open in list (the editors, and
 * Terminal while the folder has a place for one).
 */
function FolderInfoRow({ workspaceId, compact }: { workspaceId: string; compact: boolean }) {
  const root = useWorkspacesStore((s) => s.byId[workspaceId]?.rootPath ?? "");
  const managed = useWorkspacesStore((s) => s.byId[workspaceId]?.managedDir ?? "");
  const terminal = useWorkspaceTerminal(workspaceId);
  const dir = root || managed;
  return (
    <DetailRow
      icon={<Folder aria-hidden />}
      label="Folder"
      testId="workspace-folder-info"
      value={tildify(dir)}
      full={dir}
      detail={root ? "its root" : "kept by the app"}
      valueTestId="workspace-folder-path"
      right={
        <>
          {dir && <CopyPath path={dir} testId="workspace-folder-copy-path" />}
          <OpenInSplit target={workspaceOpenIn(workspaceId, terminal)} compact={compact} testId="workspace-folder" />
        </>
      }
    />
  );
}

/**
 * Instructions and skills: what every thread in the workspace gets (the daemon appends the
 * instructions; the skills folder is an --add-dir), in a project's Details grammar
 * (DetailRow.tsx). `compact`: Open in Finder shows its icon only.
 */
export function WorkspaceInstructions({ workspaceId, compact }: { workspaceId: string; compact: boolean }) {
  return (
    <div data-testid="workspace-contents">
      <SectionHeader label="Instructions and skills" detail="added to every thread in this workspace" testId="workspace-contents-title" />
      <div className="rounded-lg border bg-cf-surface">
        <InstructionsRow workspaceId={workspaceId} />
        <SkillsRow workspaceId={workspaceId} />
        <FolderInfoRow workspaceId={workspaceId} compact={compact} />
      </div>
    </div>
  );
}
