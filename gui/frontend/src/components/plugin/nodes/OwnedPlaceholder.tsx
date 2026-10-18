import { MessageSquare, Terminal } from "lucide-react";
import type { NodeProps } from "../registry";

/**
 * A plugin-owned thread or terminal node, until they render (PR 6 replaces these two
 * renderers in nodes/index.ts): a bordered box with what it will show.
 */
function Placeholder({ kind, heading, detail }: { kind: "thread" | "terminal"; heading: string; detail: string }) {
  const Icon = kind === "thread" ? MessageSquare : Terminal;
  return (
    <div className="flex min-w-0 flex-col items-center gap-1 rounded-lg border border-dashed border-border px-3 py-4 text-center" data-testid="plugin-placeholder" data-kind={kind}>
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <p className="text-body-sm font-medium">{heading}</p>
      <p className="text-caption-sm">{detail}</p>
      <p className="text-caption-sm">Arrives with a later version</p>
    </div>
  );
}

export function ThreadPlaceholder({ data }: NodeProps<"thread">) {
  return <Placeholder kind="thread" heading="Plugin thread" detail={data.placeholder || `Thread ${data.threadId}`} />;
}

export function TerminalPlaceholder({ data }: NodeProps<"terminal">) {
  return <Placeholder kind="terminal" heading={data.title || "Plugin terminal"} detail={`Terminal ${data.terminalId}`} />;
}
