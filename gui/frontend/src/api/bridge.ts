import { Code, ConnectError } from "@connectrpc/connect";
import { CommandFailedSchema } from "@/gen/codefoundry/v1/command_pb";
import type { BridgeError } from "@/lib/bridge";
import { errorMessage } from "./stream";

/**
 * A failed CommandService.Invoke (or ThreadService.ProxyFetch, docs/notes/bridge-fetch.md)
 * as a page's bridge reports it (docs/notes/bridge-2-gui.md): NotFound (no such command or
 * thread) and FailedPrecondition (not available in the thread's context) are
 * `unavailable`, InvalidArgument is `invalid`, DeadlineExceeded `timeout`, anything else
 * (a fetch's network error, a response too big) `failed`. A FailedPrecondition with a
 * CommandFailed detail is the command's own refusal (a user-only setting, a plugin's
 * error): it ran and failed, so `failed`. A confirmation (also FailedPrecondition) never gets here:
 * invokeConfirmed asks the user first.
 */
export function bridgeErrorOf(err: unknown): BridgeError {
  const message = errorMessage(err);
  if (!(err instanceof ConnectError)) return { code: "failed", message };
  switch (err.code) {
    case Code.FailedPrecondition:
      return { code: err.findDetails(CommandFailedSchema).length > 0 ? "failed" : "unavailable", message };
    case Code.NotFound:
      return { code: "unavailable", message };
    case Code.InvalidArgument:
      return { code: "invalid", message };
    case Code.DeadlineExceeded:
      return { code: "timeout", message };
    default:
      return { code: "failed", message };
  }
}
