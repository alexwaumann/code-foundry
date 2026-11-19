import { GitPullRequest, Plug } from "lucide-react";
import type { ThreadSnoozeEventView } from "@/api/snoozeEvents";

/** What a snooze until an event waits on, as a glyph: a pull request or a plugin's plug. */
export function SnoozeEventIcon({ kind, className }: { kind: ThreadSnoozeEventView["kind"]; className?: string }) {
  const Icon = kind === "plugin" ? Plug : GitPullRequest;
  return <Icon className={className} aria-hidden data-testid="snooze-event-icon" data-kind={kind} />;
}
