import { useShallow } from "zustand/react/shallow";
import { FolderGit2 } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { tildify } from "@/lib/path";
import { worktreeBranch } from "@/lib/threadRow";
import { runThreadIn } from "@/stores/threadActions";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

function MemberItem({ projectId, path, current, queued, onPick }: { projectId: string; path: string; current: boolean; queued: boolean; onPick: (projectId: string) => void }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => worktreeBranch(s, projectId, path));
  return (
    <CommandItem
      value={projectId}
      keywords={[name, branch, path]}
      disabled={current}
      onSelect={() => {
        onPick(projectId);
      }}
      data-member={projectId}
      className="gap-3 py-2"
    >
      <FolderGit2 className="size-4 text-cf-info/90" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-caption">
          {branch} · {tildify(path)}
        </span>
      </span>
      {(current || queued) && <span className="ml-auto text-caption">{current ? "runs here" : "queued"}</span>}
    </CommandItem>
  );
}

/**
 * The palette's "Run in…" page: the members of the thread's workspace; picking one
 * invokes thread.run-in for the thread (the daemon moves a live thread once it is idle).
 */
export function RunInPicker({ threadId, close }: { threadId: string; close: () => void }) {
  const name = useThreadsStore((s) => s.byId[threadId]?.name || threadId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const pending = useThreadsStore((s) => s.byId[threadId]?.pendingWorktreePath ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const members = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.projectId}\u0000${m.worktreePath}`)));
  const wsName = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? "");
  const pick = (projectId: string) => {
    close();
    void runThreadIn(threadId, projectId);
  };
  return (
    <Command loop data-testid="runin-picker">
      <CommandInput autoFocus placeholder={`Run ${name} in…`} />
      <CommandList>
        <CommandEmpty>{workspaceId ? "No matching members." : "This thread does not belong to a workspace."}</CommandEmpty>
        <CommandGroup heading={wsName ? `Members of ${wsName}` : "Members"}>
          {members.map((k) => {
            const [projectId = "", path = ""] = k.split("\u0000");
            return <MemberItem key={k} projectId={projectId} path={path} current={path === cwd} queued={path === pending} onPick={pick} />;
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
