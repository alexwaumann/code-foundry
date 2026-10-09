import { Code, ConnectError } from "@connectrpc/connect";

/** What the GUI says when the daemon it talks to predates an RPC the app needs. */
export const OUTDATED_DAEMON_MESSAGE = "The running daemon is older than the app. Restart it (Daemon → Restart) to use this feature.";

/**
 * A call to an RPC the running daemon does not have. Connect reports a missing route as
 * Unimplemented (an HTTP 404 from the daemon's mux maps to it, with "HTTP 404" as the
 * message), which tells the user nothing.
 */
export class OutdatedDaemonError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(OUTDATED_DAEMON_MESSAGE);
    this.name = "OutdatedDaemonError";
    this.cause = cause;
  }
}

/** True for errors meaning "the daemon has no such RPC" (Unimplemented / HTTP 404). */
export function isOutdatedDaemon(err: unknown): boolean {
  if (err instanceof OutdatedDaemonError) return true;
  return err instanceof ConnectError && err.code === Code.Unimplemented;
}

/**
 * For calls to RPCs newer than some daemons in the wild (ListRefs, StageAttachment):
 * Unimplemented becomes OutdatedDaemonError; every other error passes through unchanged.
 */
export function orOutdatedDaemon(err: unknown): unknown {
  return isOutdatedDaemon(err) && !(err instanceof OutdatedDaemonError) ? new OutdatedDaemonError(err) : err;
}
