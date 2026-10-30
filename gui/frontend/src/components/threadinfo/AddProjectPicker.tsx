import { useMemo, type ReactElement } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus } from "lucide-react";
import { ComposerPicker, type PickerGroup } from "@/components/compose/ComposerPicker";
import { byName } from "@/components/compose/useProjectRows";
import { tildify } from "@/lib/path";
import { useProjectRefusals } from "@/stores/placementChecks";
import { useProjectsStore } from "@/stores/projects";
import { addThreadProject } from "@/stores/threadProjects";
import { useThreadsStore } from "@/stores/threads";

const SEP = "\u0001";

/**
 * The card's Add project: the composer's multi-select list of every registered project
 * by name, opened from the project row's menu and anchored under the row. The thread's
 * projects are checked; a pick adds that project (thread.project.add) and the list stays
 * open for the next. In worktree mode a project whose worktree for the thread's branch
 * the daemon would refuse (it moved to another branch) is greyed, the refusal its tooltip.
 */
export function AddProjectPicker({ threadId, members, open, onOpenChange, anchor }: { threadId: string; members: readonly string[]; open: boolean; onOpenChange: (open: boolean) => void; anchor: ReactElement }) {
  const keys = useProjectsStore(
    useShallow((s) =>
      s.order
        .flatMap((id) => {
          const r = s.byId[id];
          return r ? [[r.name, id, r.path, r.git ? "git" : ""].join(SEP)] : [];
        })
        .sort(byName),
    ),
  );
  const branch = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t?.createdWorktree ? t.branch : "";
  });
  const candidates = useMemo(
    () =>
      keys.flatMap((k) => {
        const [, id = "", , git = ""] = k.split(SEP);
        return git && !members.includes(id) ? [id] : [];
      }),
    [keys, members],
  );
  const refusals = useProjectRefusals(candidates, branch, open);
  const groups = useMemo<PickerGroup[]>(
    () => [
      {
        options: keys.map((k) => {
          const [label = "", value = "", path = ""] = k.split(SEP);
          return { value, label, detail: tildify(path), unavailable: refusals[value] };
        }),
      },
    ],
    [keys, refusals],
  );
  return (
    <ComposerPicker
      label="Add project"
      icon={Plus}
      text="Add project"
      value=""
      multi
      selected={members}
      groups={groups}
      onChange={(id) => {
        if (!members.includes(id)) void addThreadProject(threadId, id);
      }}
      filterPlaceholder="Filter projects…"
      contentClassName="w-(--radix-popover-trigger-width) min-w-0"
      anchor={anchor}
      open={open}
      onOpenChange={onOpenChange}
      focusAfter={() => {}}
      data-testid="ti-add-project-picker"
    />
  );
}
