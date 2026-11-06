import { Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import type { TaskItem } from "@/lib/taskItems";
import { cn } from "@/lib/utils";
import { setTaskChecked, taskCheckKey, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";

/**
 * A task-list box of a description the viewer can edit, in the gutter where the read-only
 * <input> hangs. It shows the state asked for until the detail has the new text: a spinner
 * while pr.checkbox runs, the old state again if it fails.
 */
export function TaskBox({ prRef, item }: { prRef: PrRef; item: TaskItem }) {
  const asked = usePrPanelStore((s) => s.taskChecks[taskCheckKey(prRef, item.index)]);
  const saving = asked !== undefined;
  const checked = asked ?? item.checked;
  return (
    <span className="cf-task-box absolute top-[0.2em] left-0 flex" data-testid="pr-task-box">
      <Checkbox
        checked={checked}
        aria-label={item.text || "Task"}
        aria-busy={saving}
        className={cn("hover:border-cf-focus hover:ring-[3px] hover:ring-cf-focus/50", saving && "opacity-75 [&_[data-slot=checkbox-indicator]]:invisible")}
        onCheckedChange={(next) => {
          void setTaskChecked(prRef, item, next === true);
        }}
      />
      {saving && (
        <span className={cn("pointer-events-none absolute inset-0 grid place-content-center", checked ? "text-cf-accent-foreground" : "text-cf-text-muted")}>
          <Loader2 className="size-3 animate-spin" aria-hidden data-testid="pr-task-saving" />
        </span>
      )}
    </span>
  );
}
