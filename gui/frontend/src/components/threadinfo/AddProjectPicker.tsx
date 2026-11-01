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
 * The card's Add project: the composer's list of the registered projects not in the
 * thread's set, by name, opened from the project row's menu and anchored under the row.
 * One pick adds that project (thread.project.add; the project row says "Adding …" until
 * the daemon has placed its checkout) and the list closes: a user adds one project at a
 * time, and the add takes a moment in worktree mode. In worktree mode a project whose
 * worktree for the thread's branch the daemon would refuse (it moved to another branch)
 * is greyed, the refusal its tooltip. With every project in the set, the list says so.
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
  const groups = useMemo<PickerGroup[]>(() => {
    const options = keys.flatMap((k) => {
      const [label = "", value = "", path = ""] = k.split(SEP);
      return members.includes(value) ? [] : [{ value, label, detail: tildify(path), unavailable: refusals[value] }];
    });
    return [{ options, status: options.length === 0 ? "Every project is in this thread." : undefined }];
  }, [keys, members, refusals]);
  return (
    <ComposerPicker
      label="Add project"
      icon={Plus}
      text="Add project"
      value=""
      groups={groups}
      onChange={(id) => {
        if (!members.includes(id)) void addThreadProject(threadId, id);
      }}
      filterPlaceholder="Filter projects…"
      contentClassName="w-[calc(var(--radix-popover-trigger-width)/var(--cf-zoom))] min-w-0"
      anchor={anchor}
      open={open}
      onOpenChange={onOpenChange}
      focusAfter={() => {}}
      data-testid="ti-add-project-picker"
    />
  );
}
