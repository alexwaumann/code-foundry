import { Check } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { runPrTask, taskKey, usePrTasksStore } from "@/stores/prTasks";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import type { TaskKind } from "./readiness";
import { SplitButton } from "./SplitButton";
import { buttonLabel, menuHint, menuLabel, TASK_TITLES, type TaskRouting, type TaskTarget } from "./taskRouting";

const targetKey = (t: TaskTarget): string => (t.threadId === null ? "new" : `${t.kind}:${t.threadId}`);

/**
 * A readiness row's thread task, "Fix in this thread" and the like (no icon, agreed): the
 * main part hands the row's issue to the default target (taskRouting), the chevron lists
 * every target with the default first and checked. `routing` is the box's (useTaskRouting,
 * read once for every row). Runs pr.task (runPrTask); while it runs the main part spins
 * and is aria-disabled, and a second press sends nothing.
 */
export function TaskButton({ kind, verb, prRef, routing }: { kind: TaskKind; verb: string; prRef: PrRef; routing: TaskRouting }) {
  const busy = usePrTasksStore((s) => s.running[taskKey(prRef, kind)] ?? false);
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
