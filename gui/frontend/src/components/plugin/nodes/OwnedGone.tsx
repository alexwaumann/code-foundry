import { MessageSquare, SquareTerminal } from "lucide-react";

/**
 * A thread or terminal node whose thread or terminal is gone (removed, closed, the daemon
 * restarted), or not known yet: a muted empty state in a dashed box.
 */
export function OwnedGone({ kind, heading, detail, testId }: { kind: "thread" | "terminal"; heading: string; detail: string; testId: string }) {
  const Icon = kind === "thread" ? MessageSquare : SquareTerminal;
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 rounded-lg border border-dashed border-border px-3 py-5 text-center" data-testid={testId} data-kind={kind}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <p className="text-body-sm font-medium text-muted-foreground">{heading}</p>
      <p className="text-caption-sm">{detail}</p>
    </div>
  );
}
