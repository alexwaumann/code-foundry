/**
 * The errors the daemon's CommandService.Invoke answers with, built the way it builds
 * them, for fakes of the daemon (src/test). A module of its own so a test that mocks
 * api/command can still import these from its factory.
 */
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { CommandFailedSchema, ConfirmationRequiredSchema } from "@/gen/codefoundry/v1/command_pb";

/** How the daemon asks for a confirmation: FailedPrecondition with a ConfirmationRequired detail (api/command confirmationOf reads it). */
export function confirmationRequiredError(c: { command: string; title?: string; message: string; args?: Record<string, string>; confirmLabel?: string }): ConnectError {
  const detail = create(ConfirmationRequiredSchema, { command: c.command, title: c.title ?? "", message: c.message, args: c.args ?? {}, confirmLabel: c.confirmLabel ?? "" });
  return new ConnectError(c.message, Code.FailedPrecondition, undefined, [{ desc: ConfirmationRequiredSchema, value: detail }]);
}

/**
 * How a command refuses on its own terms (a user-only setting, a plugin's refusal):
 * FailedPrecondition with a CommandFailed detail (api/bridge.ts reads it as "failed").
 */
export function commandFailedError(command: string, message: string): ConnectError {
  return new ConnectError(message, Code.FailedPrecondition, undefined, [{ desc: CommandFailedSchema, value: create(CommandFailedSchema, { command }) }]);
}
