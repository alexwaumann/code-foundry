import type { PluginStateView, PluginView, Tone } from "@/api/plugin";

/** A plugin's state as its pill says it, with the pill's tone. */
export function statePill(p: Pick<PluginView, "state" | "enabled" | "needsConsent" | "disabledReason">): { label: string; tone: Tone } {
  const words: Record<PluginStateView, { label: string; tone: Tone }> = {
    running: { label: "Running", tone: "ok" },
    starting: { label: "Starting", tone: "" },
    crashed: { label: "Crashed", tone: "attention" },
    failed: { label: "Failed", tone: "error" },
    stopping: { label: "Stopping", tone: "" },
    stopped: { label: "Stopped", tone: "muted" },
    disabled: { label: "Disabled", tone: "muted" },
    unknown: { label: "Unknown", tone: "muted" },
  };
  if (p.state === "disabled" && p.needsConsent && p.disabledReason) return { label: "Needs consent", tone: "attention" };
  return words[p.state];
}

/** "pid 4211 · 2 restarts": what is running, in one line ("" for a plugin that is not). */
export function processLine(p: Pick<PluginView, "pid" | "restarts" | "state">): string {
  const parts: string[] = [];
  if (p.pid > 0 && (p.state === "running" || p.state === "starting")) parts.push(`pid ${String(p.pid)}`);
  if (p.restarts > 0) parts.push(`${String(p.restarts)} ${p.restarts === 1 ? "restart" : "restarts"}`);
  return parts.join(" · ");
}

/** Who gets a contribution: "every project", "every project and threads without one", or names. */
export function scopeWords(projects: readonly string[], noProject: boolean, projectName: (id: string) => string): string {
  const base = projects.length === 0 ? "every project" : projects.map(projectName).join(", ");
  return noProject ? `${base} and threads without a project` : base;
}
