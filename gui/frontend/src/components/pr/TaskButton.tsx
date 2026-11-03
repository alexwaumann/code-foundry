import { Check } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { runPrTask, taskKey, usePrTasksStore } from "@/stores/prTasks";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { samePullRequest } from "./model";
import type { TaskKind } from "./readiness";
import { SplitButton } from "./SplitButton";
import { buttonLabel, isProjectRepo, menuHint, menuLabel, TASK_TITLES, taskRouting, type TaskTarget } from "./taskRouting";

const targetKey = (t: TaskTarget): string => (t.threadId === null ? "new" : `${t.kind}:${t.threadId}`);

/** The selected thread's id; null for anything else. */
const useSelectedThread = (): string | null => useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : null));

/**
 * The threads routing reads: the selected one and every thread that links ref. The
 * store's own objects, so a thread elsewhere changing re-renders nothing.
 */
function useTaskThreads(ref: PrRef, selected: string | null) {
  return useThreadsStore(useShallow((s) => Object.values(s.byId).filter((t) => t.id === selected || t.linkedPullRequests.some((l) => samePullRequest(l, ref)))));
}

/** Whether a project is a clone of the repository; true until projects have loaded (no clone hint on a guess). */
function useIsProject(ref: PrRef, repoSlug: string): boolean {
  return useProjectsStore((s) => !s.loaded || isProjectRepo(s.order.map((id) => s.byId[id]?.githubSlug ?? ""), ref.slug, repoSlug));
}

/**
 * A readiness row's thread task, "Fix in this thread" and the like (no icon, agreed): the
 * main part hands the row's issue to the default target (taskRouting), the chevron lists
 * every target with the default first and checked. Runs pr.task (runPrTask); while it
 * runs the main part spins and is aria-disabled, and a second press sends nothing.
 */
export function TaskButton({ kind, verb, prRef, detail }: { kind: TaskKind; verb: string; prRef: PrRef; detail: PullRequestDetailView }) {
  const selected = useSelectedThread();
  const threads = useTaskThreads(prRef, selected);
  const isProject = useIsProject(prRef, detail.pullRequest.repoSlug);
  const busy = usePrTasksStore((s) => s.running[taskKey(prRef, kind)] ?? false);
  const routing = useMemo(() => taskRouting({ selection: selected, ref: prRef, threads, isProject }), [selected, prRef, threads, isProject]);
  const label = buttonLabel(verb, routing.default);
  const run = (t: TaskTarget) => void runPrTask(prRef, kind, t);
  return (
    <SplitButton
      label={label}
      tip={label}
      tone="neutral"
      size="xs"
      reason={null}
      busy={busy}
      onRun={() => {
        run(routing.default);
      }}
      menuLabel={`${verb} in…`}
      menuClassName="w-64"
      testId={`pr-task-${kind}`}
    >
      {(close) => (
        <>
          <DropdownMenuLabel>{TASK_TITLES[kind]}</DropdownMenuLabel>
          {routing.targets.map((t) => {
            const hint = menuHint(t);
            const text = menuLabel(t);
            return (
              <DropdownMenuItem
                key={targetKey(t)}
                data-testid="pr-task-target"
                data-target={t.kind}
                data-default={t === routing.default || undefined}
                onSelect={() => {
                  close();
                  run(t);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <Tip label={text} whenTruncated>
                    <span className="truncate">{text}</span>
                  </Tip>
                  {hint && <span className="text-caption">{hint}</span>}
                </span>
                {t === routing.default && <Check className="ml-auto" aria-label="Default" />}
              </DropdownMenuItem>
            );
          })}
        </>
      )}
    </SplitButton>
  );
}
