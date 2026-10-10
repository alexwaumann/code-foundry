import { useShallow } from "zustand/react/shallow";
import { FolderGit2 } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { tildify } from "@/lib/path";
import { worktreeBranch } from "@/lib/threadRow";
import { runSessionIn } from "@/stores/sessionActions";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";

function MemberItem({ repoId, path, current, queued, onPick }: { repoId: string; path: string; current: boolean; queued: boolean; onPick: (repoId: string) => void }) {
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  const branch = useReposStore((s) => worktreeBranch(s, repoId, path));
  return (
    <CommandItem
      value={repoId}
      keywords={[name, branch, path]}
      disabled={current}
      onSelect={() => {
        onPick(repoId);
      }}
      data-member={repoId}
      className="gap-3 py-2"
    >
      <FolderGit2 className="size-4 text-sky-400/90" aria-hidden />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {branch} · {tildify(path)}
        </span>
      </span>
      {(current || queued) && <span className="ml-auto text-xs text-muted-foreground">{current ? "runs here" : "queued"}</span>}
    </CommandItem>
  );
}

/**
 * The palette's "Run in…" page: the members of the thread's workspace; picking one
 * invokes session.run-in for the thread (the daemon types /cd once it is idle).
 */
export function RunInPicker({ sessionId, close }: { sessionId: string; close: () => void }) {
  const name = useSessionsStore((s) => s.byId[sessionId]?.name || sessionId);
  const cwd = useSessionsStore((s) => s.byId[sessionId]?.worktreePath ?? "");
  const pending = useSessionsStore((s) => s.byId[sessionId]?.pendingWorktreePath ?? "");
  const workspaceId = useSessionsStore((s) => s.byId[sessionId]?.workspaceId ?? "");
  const members = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => `${m.repoId}\u0000${m.worktreePath}`)));
  const wsName = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? "");
  const pick = (repoId: string) => {
    close();
    void runSessionIn(sessionId, repoId);
  };
  return (
    <Command loop data-testid="runin-picker">
      <CommandInput autoFocus placeholder={`Run ${name} in…`} />
      <CommandList>
        <CommandEmpty>{workspaceId ? "No matching members." : "This thread does not belong to a workspace."}</CommandEmpty>
        <CommandGroup heading={wsName ? `Members of ${wsName}` : "Members"}>
          {members.map((k) => {
            const [repoId = "", path = ""] = k.split("\u0000");
            return <MemberItem key={k} repoId={repoId} path={path} current={path === cwd} queued={path === pending} onPick={pick} />;
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
