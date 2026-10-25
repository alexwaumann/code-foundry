import { FolderGit2, Layers } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useThreadCheckouts } from "@/components/thread/useThreadCheckouts";
import { tildify } from "@/lib/path";
import { WORKSPACE_FOLDER, WORKSPACE_PRIMARY } from "@/lib/projectSet";
import { worktreeBranch } from "@/lib/threadRow";
import { runThreadIn } from "@/stores/threadActions";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

function MemberItem({ projectId, path, current, queued, onPick }: { projectId: string; path: string; current: boolean; queued: boolean; onPick: (projectId: string) => void }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const branch = useProjectsStore((s) => (path ? worktreeBranch(s, projectId, path) : ""));
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
      <FolderGit2 className="size-4 text-cf-info-text/90" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-caption">{[branch, path ? tildify(path) : ""].filter(Boolean).join(" · ")}</span>
      </span>
      {(current || queued) && <span className="ml-auto text-caption">{current ? "runs here" : "queued"}</span>}
    </CommandItem>
  );
}

/**
 * The palette's "Run in…" page: the thread's workspace folder ("Workspace folder", when it
 * references one) and its projects' checkouts; picking one invokes thread.run-in for the
 * thread (the daemon moves a live thread once it is idle).
 */
export function RunInPicker({ threadId, close }: { threadId: string; close: () => void }) {
  const name = useThreadsStore((s) => s.byId[threadId]?.name || threadId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const pending = useThreadsStore((s) => s.byId[threadId]?.pendingWorktreePath ?? "");
  const primary = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.workspaceId ?? "");
  const wsName = useWorkspacesStore((s) => (workspaceId ? (s.byId[workspaceId]?.name ?? workspaceId) : ""));
  const { projectIds, paths } = useThreadCheckouts(threadId);
  const sorted = [...projectIds].sort();
  const pick = (target: string) => {
    close();
    void runThreadIn(threadId, target);
  };
  return (
    <Command loop data-testid="runin-picker">
      <CommandInput autoFocus placeholder={`Run ${name} in…`} />
      <CommandList>
        <CommandEmpty>{sorted.length > 1 || workspaceId ? "No matching checkouts." : "This thread has nowhere else to run."}</CommandEmpty>
        {workspaceId && (
          <CommandGroup heading="Workspace">
            <CommandItem
              value={WORKSPACE_PRIMARY}
              keywords={[wsName]}
              disabled={primary === ""}
              onSelect={() => {
                pick(WORKSPACE_PRIMARY);
              }}
              data-member={WORKSPACE_PRIMARY}
              className="gap-3 py-2"
            >
              <Layers className="size-4 text-cf-highlight-text" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{WORKSPACE_FOLDER}</span>
                <span className="truncate text-caption">{wsName}&apos;s folder</span>
              </span>
              {primary === "" && <span className="ml-auto text-caption">runs here</span>}
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Projects">
          {sorted.map((projectId) => {
            const path = paths[projectId] ?? "";
            return <MemberItem key={projectId} projectId={projectId} path={path} current={projectId === primary} queued={path !== "" && path === pending && path !== cwd} onPick={pick} />;
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
