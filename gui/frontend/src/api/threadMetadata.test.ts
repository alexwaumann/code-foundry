import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ThreadReportStatus, ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { toThreadView } from "./threads";

describe("thread metadata mapping", () => {
  it("maps who created a thread, its brief, labels, report and budget", () => {
    const v = toThreadView(
      create(ThreadSchema, {
        id: "s2",
        createdBy: "s1",
        createdByName: "Parent",
        brief: "say hi",
        labels: ["a", "b"],
        reportStatus: ThreadReportStatus.BLOCKED,
        reportSummary: "need a key",
        reportData: '{"n":1}',
        reportAt: timestampFromMs(7000),
        budgetUsd: 2.5,
      }),
    );
    expect(v).toMatchObject({ createdBy: "s1", createdByName: "Parent", brief: "say hi", labels: ["a", "b"], budgetUsd: 2.5 });
    expect(v.report).toEqual({ status: "blocked", summary: "need a key", data: '{"n":1}', atMs: 7000 });
  });

  it("has no report and no creator by default", () => {
    const v = toThreadView(create(ThreadSchema, { id: "s1" }));
    expect(v).toMatchObject({ createdBy: "", createdByName: "", brief: "", labels: [], report: null, budgetUsd: 0 });
  });
});
