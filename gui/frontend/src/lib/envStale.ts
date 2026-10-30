/**
 * The thread info card's "Plugin environment changed" note (its project row's hover card,
 * docs/notes/plugins-env-restart.md): what changed, when the daemon said, and what the
 * title menu's Restart Claude does.
 */
export function envStaleTip(change: string): string {
  const what = change ? `${change}.\n` : "";
  return `${what}Claude is still running with the old environment. Restart Claude restarts the Claude process with the new one; the conversation continues.`;
}
