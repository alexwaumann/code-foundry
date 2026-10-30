/**
 * The read-only subagent view's commands (internal/command/commands_agents_view.go), as
 * this window starts them: thread.agent.open from the entry points (the Agent rows' Open,
 * the strip's run names, the thread info card's agent rows), thread.agent.up from the view's back
 * buttons. Escape reaches thread.agent.up through the registry's keybinding.
 */
import { isStartable, startCommandNamed } from "@/keys/bindings";
import { runCommand, useCommandsStore } from "./commands";
import { leaveSubagent } from "./subagentView";
import { threadContext } from "./threadActions";

export const SUBAGENT_COMMANDS = {
  open: "thread.agent.open",
  up: "thread.agent.up",
} as const;

/** Whether thread.agent.open can start here (a daemon that predates it does not list it): the entry points show only then. */
export function useCanOpenAgents(): boolean {
  return useCommandsStore((s) => s.commands.some((c) => c.name === SUBAGENT_COMMANDS.open && isStartable(c)));
}

/** Opens a thread's run: thread.agent.open, which the daemon answers with UiIntent.ShowAgentRun. */
export function openAgentRun(threadId: string, runId: string): Promise<boolean> {
  return runCommand(SUBAGENT_COMMANDS.open, { id: threadId, run: runId }, threadContext(threadId));
}

/**
 * Back to the parent thread: thread.agent.up as the palette runs it (presented in this
 * window). Right after a run opened, the command list may still be the thread's (it is
 * re-listed for the new context after a short debounce): the button then does what the
 * presenter does.
 */
export function goUpFromSubagent(): boolean {
  return startCommandNamed(SUBAGENT_COMMANDS.up) || leaveSubagent();
}
