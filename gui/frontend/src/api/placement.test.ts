import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { CheckPlacementResponseSchema, PlacementOutcome } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { toPlacementView } from "./placement";

describe("toPlacementView", () => {
  it("maps each project's outcome", () => {
    const res = create(CheckPlacementResponseSchema, {
      branch: "feat/x",
      members: [
        { projectId: "r1", projectName: "api", outcome: PlacementOutcome.SHARE, path: "/wt/api", branch: "feat/x" },
        { projectId: "r2", projectName: "web", outcome: PlacementOutcome.REFUSED, message: "web's main checkout is on feat/x" },
        { projectId: "r3", projectName: "docs", outcome: PlacementOutcome.FOLDER, path: "/docs" },
      ],
    });
    expect(toPlacementView(res)).toEqual({
      branch: "feat/x",
      branchNamedAtCreate: false,
      members: [
        { projectId: "r1", projectName: "api", outcome: "share", path: "/wt/api", branch: "feat/x", message: "" },
        { projectId: "r2", projectName: "web", outcome: "refused", path: "", branch: "", message: "web's main checkout is on feat/x" },
        { projectId: "r3", projectName: "docs", outcome: "folder", path: "/docs", branch: "", message: "" },
      ],
    });
  });
  it("maps a branch named at create", () => {
    expect(toPlacementView(create(CheckPlacementResponseSchema, { branchNamedAtCreate: true, members: [{ projectId: "r1", outcome: PlacementOutcome.NEW }] }))).toMatchObject({
      branch: "",
      branchNamedAtCreate: true,
      members: [{ outcome: "new", path: "" }],
    });
  });
});
