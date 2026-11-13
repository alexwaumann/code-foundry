import { ThreadInfoToggle } from "@/components/threadinfo/ThreadInfoToggle";

/**
 * A subagent run's header's right side (SubagentPane): the thread info card's toggle. The
 * thread's own header is ThreadHeader's.
 */
export function HeaderActions() {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <ThreadInfoToggle />
    </span>
  );
}
