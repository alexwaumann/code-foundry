/**
 * The thread info card's "Plugin environment changed" note (its project row's hover card,
 * docs/notes/plugins-env-restart.md): what changed, when the daemon said, and what the
 * title menu's Restart Claude does. `restart` false on a read-only card (a subagent's),
 * which has no thread menu and so no Restart Claude.
 */
export function envStaleTip(change: string, restart = true): string {
  const what = change ? `${change}.\n` : "";
  const how = restart ? " Restart Claude restarts the Claude process with the new one; the conversation continues." : "";
  return `${what}Claude is still running with the old environment.${how}`;
}
