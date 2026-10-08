import { toast } from "sonner";
import type { GitOpView, GitOpsEventView } from "@/api/gitops";
import { GitOpProgress, GitOpResult } from "@/components/gitops/GitOpToast";
import { runCommand } from "./commands";

/** What to show for an op: a progress toast while queued/running, then its result. */
export type GitOpToastAction = { show: "progress" | "result"; op: GitOpView };

/**
 * Plans the toasts for one gitops event. `shown` holds the ids that have a progress
 * toast up. Pure, so the rules are unit-tested:
 *  - queued/started: progress (one toast per op id; sonner updates it in place);
 *  - finished: result, replacing the progress toast (CLI-started ops get one too);
 *  - snapshot (on (re)connect or after drops): progress for active ops, and results only
 *    for ops whose progress toast is still up, so old results are not replayed.
 */
export function planGitOpToasts(shown: ReadonlySet<string>, ev: GitOpsEventView): { shown: Set<string>; actions: GitOpToastAction[] } {
  const next = new Set(shown);
  const actions: GitOpToastAction[] = [];
  const progress = (op: GitOpView) => {
    next.add(op.id);
    actions.push({ show: "progress", op });
  };
  const result = (op: GitOpView) => {
    next.delete(op.id);
    actions.push({ show: "result", op });
  };
  switch (ev.kind) {
    case "queued":
    case "started":
      progress(ev.op);
      break;
    case "finished":
      result(ev.op);
      break;
    case "snapshot":
      for (const op of ev.ops) {
        if (op.state === "queued" || op.state === "running") progress(op);
        else if (shown.has(op.id)) result(op);
      }
      break;
  }
  return { shown: next, actions };
}

/** Success toasts linger briefly; failures stay until dismissed (they may need reading). */
const SUCCESS_MS = 5000;

function show({ show, op }: GitOpToastAction): void {
  if (show === "progress") {
    toast.loading(op.title, { id: op.id, description: <GitOpProgress op={op} />, duration: Infinity });
    return;
  }
  if (op.state === "failed") {
    showFailure(op, false);
    return;
  }
  // A created PR offers to open it; pr-open and open-url have already opened theirs.
  const openPr = op.kind === "pr-create" && op.url ? { label: "Open", onClick: () => void runCommand("view.open.url", { url: op.url }) } : undefined;
  toast.success(op.title, { id: op.id, description: <GitOpResult op={op} />, duration: SUCCESS_MS, action: openPr });
}

/** Failure toast; toggling the output re-issues it so sonner re-measures its height. */
function showFailure(op: GitOpView, expanded: boolean): void {
  const onToggle = () => {
    showFailure(op, !expanded);
  };
  toast.error(`${op.title} failed`, {
    id: op.id,
    description: <GitOpResult op={op} expanded={expanded} onToggle={onToggle} />,
    duration: Infinity,
    closeButton: true,
  });
}

let shown: ReadonlySet<string> = new Set();

/** EventService gitops handler: a progress toast while an op runs, a result toast when it ends. */
export function applyGitOpsEvent(ev: GitOpsEventView): void {
  const plan = planGitOpToasts(shown, ev);
  shown = plan.shown;
  for (const a of plan.actions) show(a);
}
