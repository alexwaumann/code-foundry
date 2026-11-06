import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runUpdates, useUpdateRunStore, type UpdateScope, type UpdateStep } from "@/stores/updateRun";
import { updateAllWords } from "./model";

/** "Update all N" or "Updating 2 of 3…" in the Needs you header. `steps` is read when pressed: what can be updated then. */
export function UpdateAll({ scope, available, steps, testId }: { scope: UpdateScope; available: number; steps: () => readonly UpdateStep[]; testId: string }) {
  const running = useUpdateRunStore((s) => s[scope].running);
  const at = useUpdateRunStore((s) => s[scope].at);
  const total = useUpdateRunStore((s) => s[scope].total);
  const words = updateAllWords({ running, at, total }, available);
  if (!words) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      className="h-5 bg-transparent dark:bg-transparent"
      disabled={running}
      onClick={() => {
        void runUpdates(scope, steps());
      }}
      data-testid={testId}
    >
      {running && <Loader2 className="animate-spin" aria-hidden />}
      {words}
    </Button>
  );
}
