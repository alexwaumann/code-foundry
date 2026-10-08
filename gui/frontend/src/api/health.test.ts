import { create } from "@bufbuild/protobuf";
import { DurationSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { PingResponseSchema } from "@/gen/codefoundry/v1/health_pb";
import { toHealthView } from "./health";

describe("toHealthView", () => {
  it("maps a Ping response to the view model", () => {
    const res = create(PingResponseSchema, {
      pid: 4242,
      version: "1.2.3",
      uptime: create(DurationSchema, { seconds: 90n, nanos: 500_000_000 }),
    });
    expect(toHealthView(res)).toEqual({ pid: 4242, version: "1.2.3", uptimeSeconds: 90.5 });
  });

  it("treats a missing uptime as zero", () => {
    const res = create(PingResponseSchema, { pid: 1, version: "dev" });
    expect(toHealthView(res).uptimeSeconds).toBe(0);
  });
});
