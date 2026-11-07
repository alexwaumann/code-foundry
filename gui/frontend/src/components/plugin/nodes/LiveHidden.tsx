/** What a thread or terminal node shows in place of its live view while off screen (components/plugin/live.ts). */
export function LiveHidden() {
  return <div className="absolute inset-0 bg-cf-surface" aria-hidden data-testid="plugin-live-hidden" />;
}
