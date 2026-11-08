import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { CommandFailedSchema } from "@/gen/codefoundry/v1/command_pb";
import { bridgeErrorOf } from "./bridge";

/** What the daemon attaches to a command's own failure (internal/api/command.go). */
const failedDetail = [{ desc: CommandFailedSchema, value: { command: "settings.set" } }];

describe("bridgeErrorOf", () => {
  it.each([
    ["no such verb", new ConnectError("unknown command nope.nope", Code.NotFound), "unavailable"],
    ["not in this context", new ConnectError("no thread", Code.FailedPrecondition), "unavailable"],
    ["the command's own refusal", new ConnectError("gitops.editor_command can only be changed by you in Settings", Code.FailedPrecondition, undefined, failedDetail), "failed"],
    ["a wrong arg", new ConnectError("missing arg key", Code.InvalidArgument), "invalid"],
    ["the command's own wrong arg", new ConnectError("no setting x.y", Code.InvalidArgument, undefined, failedDetail), "invalid"],
    ["too slow", new ConnectError("deadline", Code.DeadlineExceeded), "timeout"],
    ["anything else", new ConnectError("boom", Code.Internal), "failed"],
    ["not a Connect error", new Error("network"), "failed"],
  ])("%s is %s", (_name, err, code) => {
    expect(bridgeErrorOf(err).code).toBe(code);
  });
});
