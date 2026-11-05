import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { ThreadSchema, ThreadSetupPhase, ThreadSetupSchema, ThreadSetupStepKind, ThreadSetupStepSchema, ThreadSetupStepStatus } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { sameThread } from "@/stores/threads";
import { toThreadSetupView, toThreadView, type ThreadSetupView } from "./threads";

const setup = (over: Parameters<typeof create<typeof ThreadSetupSchema>>[1] = {}) =>
  create(ThreadSetupSchema, {
    phase: ThreadSetupPhase.RUNNING,
    startedAt: timestampFromMs(1000),
    background: true,
    steps: [
      create(ThreadSetupStepSchema, { kind: ThreadSetupStepKind.NAME, status: ThreadSetupStepStatus.DONE, branch: "cf/x", startedAt: timestampFromMs(1000), endedAt: timestampFromMs(1100) }),
      create(ThreadSetupStepSchema, { kind: ThreadSetupStepKind.FETCH, status: ThreadSetupStepStatus.WARNING, projectId: "p", projectName: "proj", ref: "origin/main", warning: "Could not reach origin", error: "fatal", refAt: timestampFromMs(500) }),
      create(ThreadSetupStepSchema, { kind: ThreadSetupStepKind.WORKTREE, status: ThreadSetupStepStatus.RUNNING }),
      create(ThreadSetupStepSchema, { kind: ThreadSetupStepKind.START, status: ThreadSetupStepStatus.PENDING }),
    ],
    ...over,
  });

describe("toThreadSetupView", () => {
  it("maps a setup, its steps and their times", () => {
    const v: ThreadSetupView | null = toThreadSetupView(setup());
    expect(v).toMatchObject({ phase: "running", startedAtMs: 1000, endedAtMs: null, error: "", background: true });
    expect(v?.steps.map((s) => `${s.kind} ${s.status}`)).toEqual(["name done", "fetch warning", "worktree running", "start pending"]);
    expect(v?.steps[0]).toMatchObject({ branch: "cf/x", startedAtMs: 1000, endedAtMs: 1100, refAtMs: null });
    expect(v?.steps[1]).toMatchObject({ projectId: "p", projectName: "proj", ref: "origin/main", warning: "Could not reach origin", error: "fatal", refAtMs: 500 });
  });

  it.each([
    [ThreadSetupPhase.DONE, "done"],
    [ThreadSetupPhase.FAILED, "failed"],
    [ThreadSetupPhase.CANCELLED, "cancelled"],
  ])("phase %i", (phase, want) => {
    expect(toThreadSetupView(setup({ phase }))?.phase).toBe(want);
  });

  it("is null without a setup, or for a phase it does not know", () => {
    expect(toThreadSetupView(undefined)).toBeNull();
    expect(toThreadSetupView(setup({ phase: ThreadSetupPhase.UNSPECIFIED }))).toBeNull();
    expect(toThreadView(create(ThreadSchema, {})).setup).toBeNull();
  });

  it("drops a step of a kind it does not know", () => {
    const v = toThreadSetupView(setup({ steps: [create(ThreadSetupStepSchema, {})] }));
    expect(v?.steps).toEqual([]);
  });
});

describe("sameThread on a setup", () => {
  const view = (s = setup()) => toThreadView(create(ThreadSchema, { id: "s", setup: s }));

  it("keeps a thread whose setup says the same, in new objects", () => {
    expect(sameThread(view(), view())).toBe(true);
  });

  it("sees a step change, a step leave, and a setup come or go", () => {
    const later = setup();
    const st = later.steps[3];
    if (st) st.status = ThreadSetupStepStatus.RUNNING;
    expect(sameThread(view(), view(later))).toBe(false);
    const shorter = setup();
    shorter.steps.pop();
    expect(sameThread(view(), view(shorter))).toBe(false);
    expect(sameThread(view(), toThreadView(create(ThreadSchema, { id: "s" })))).toBe(false);
  });
});
