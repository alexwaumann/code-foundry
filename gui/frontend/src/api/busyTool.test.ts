import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { toThreadView } from "./threads";

describe("Thread.busy_tool", () => {
  it.each([
    ["the running tool", "Bash make check", "Bash make check"],
    ["none", "", ""],
  ])("maps %s", (_, busyTool, want) => {
    expect(toThreadView(create(ThreadSchema, { id: "s", busyTool })).busyTool).toBe(want);
  });
});
