import { ArrowLeft, Gauge, type LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import type { AgentRunView } from "@/api/agents";
import { ClaudeMarkBrand } from "@/components/icons/ClaudeMark";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { choiceLabel, EFFORT_CHOICES } from "@/lib/compose";
import { useCommandsStore } from "@/stores/commands";
import { goUpFromSubagent, SUBAGENT_COMMANDS } from "@/stores/subagentActions";

/** Why this run takes no message, in the prompt's place. */
function subagentComposerText(status: AgentRunView["status"], parent: string): string {
  switch (status) {
    case "done":
      return `This agent finished and handed its report to ${parent}.`;
    case "failed":
      return `This agent failed, and ${parent} was told.`;
    default:
      return `Subagents take instructions from ${parent}, so this one cannot be steered.`;
  }
}

/** A composer picker's face with nothing behind it: no chevron, and not a control. */
function Chip({ icon: Icon, children, testId }: { icon?: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>; children: ReactNode; testId: string }) {
  return (
    <span className="flex h-6 max-w-64 min-w-0 items-center gap-1 px-2 text-body-sm font-medium text-cf-text-muted has-[>svg]:px-1.5" data-testid={testId}>
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Where a thread's composer sits, in its card and at its size, so nothing moves between a
 * thread and its subagent; but no editor. Why this run takes no message, what it ran as
 * (static chips), and the way back up in the send button's place. Nothing here is a
 * prompt: no draft, no drop target, no dictation or history target, no tags.
 */
export function SubagentComposer({ status, parent, model, effort, agentType }: { status: AgentRunView["status"]; parent: string; model: string; effort: string; agentType: string }) {
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === SUBAGENT_COMMANDS.up)?.keybindings[0] ?? "");
  const label = `Back to ${parent}`;
  return (
    <div className="ccard" data-testid="subagent-composer" data-status={status}>
      <p className="col-span-2 min-h-16 min-w-0 px-4 pt-3.5 pb-1 text-body break-words text-cf-text-muted" data-testid="subagent-composer-text">
        {subagentComposerText(status, parent)}
      </p>
      <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-0.5 px-2 pb-2">
        {model && (
          <Chip icon={ClaudeMarkBrand} testId="subagent-model">
            {model}
          </Chip>
        )}
        {effort && (
          <Chip icon={Gauge} testId="subagent-effort">
            {choiceLabel(EFFORT_CHOICES, effort)}
          </Chip>
        )}
        {agentType && <Chip testId="subagent-type">{agentType}</Chip>}
      </div>
      <div className="col-start-2 flex items-end pr-2 pb-2">
        <Button type="button" variant="outline" size="sm" className="max-w-64" data-testid="subagent-composer-back" onClick={() => goUpFromSubagent()}>
          <ArrowLeft aria-hidden />
          <Tip label={label} whenTruncated>
            <span className="truncate">{label}</span>
          </Tip>
          {chord && (
            <Kbd size="sm" className="ml-0.5" data-testid="subagent-composer-chord">
              {formatChord(chord).toLowerCase()}
            </Kbd>
          )}
        </Button>
      </div>
    </div>
  );
}
