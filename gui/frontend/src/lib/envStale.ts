/**
 * The thread header's "Plugin environment changed" tooltip (components/thread/EnvStaleNote,
 * docs/notes/plugins-env-restart.md): what changed, when the daemon said, and what Restart
 * does.
 */
export function envStaleTip(change: string): string {
  const what = change ? `${change}.\n` : "";
  return `${what}Claude is still running with the old environment. Restart restarts the Claude process with the new one; the conversation continues.`;
}
